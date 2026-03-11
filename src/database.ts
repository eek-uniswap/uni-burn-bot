import Database from 'better-sqlite3';
import { TokenTransfer } from './types';

// Current schema version - increment this when making schema changes
const CURRENT_SCHEMA_VERSION = 3;

type MigrationFunction = (db: Database.Database) => void;

export class TransactionDatabase {
  private db: Database.Database;

  constructor(dbPath: string = 'transactions.db') {
    this.db = new Database(dbPath);
    this.initializeSchema();
  }

  private getSchemaVersion(): number {
    try {
      const result = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
      return result.user_version || 0;
    } catch {
      return 0;
    }
  }

  private setSchemaVersion(version: number): void {
    this.db.prepare(`PRAGMA user_version = ${version}`).run();
  }

  private getMigrations(): Map<number, MigrationFunction> {
    const migrations = new Map<number, MigrationFunction>();

    // Migration 1: Rename initiator_address to burner_address
    migrations.set(1, (db: Database.Database) => {
      console.log('Running migration 1: initiator_address -> burner_address');

      // Get current table structure
      const tableInfo = db.prepare("PRAGMA table_info(token_transfers)").all() as Array<{ name: string; type: string; notnull: number; dflt_value: any; pk: number }>;
      const hasOldColumn = tableInfo.some(col => col.name === 'initiator_address');

      if (!hasOldColumn) {
        console.log('Migration 1: initiator_address column not found, skipping');
        return;
      }

      // Create new table with updated schema
      db.exec(`
        CREATE TABLE token_transfers_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tx_hash TEXT UNIQUE NOT NULL,
          block_number INTEGER NOT NULL,
          token_address TEXT NOT NULL,
          from_address TEXT NOT NULL,
          to_address TEXT NOT NULL,
          burner_address TEXT,
          value TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          gas_used INTEGER,
          gas_price TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // Copy data, mapping old column to new
      db.exec(`
        INSERT INTO token_transfers_new
        SELECT id, tx_hash, block_number, token_address, from_address, to_address,
               initiator_address as burner_address, value, timestamp, gas_used, gas_price, created_at
        FROM token_transfers;
      `);

      // Drop old table and rename new one
      db.exec(`
        DROP TABLE token_transfers;
        ALTER TABLE token_transfers_new RENAME TO token_transfers;
      `);

      // Recreate indexes
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_tx_hash ON token_transfers(tx_hash);
        CREATE INDEX IF NOT EXISTS idx_block_number ON token_transfers(block_number);
        CREATE INDEX IF NOT EXISTS idx_token_address ON token_transfers(token_address);
        CREATE INDEX IF NOT EXISTS idx_to_address ON token_transfers(to_address);
        CREATE INDEX IF NOT EXISTS idx_burner_address ON token_transfers(burner_address);
      `);

      console.log('Migration 1 completed');
    });

    // Migration 3: Add chain column, label existing Unichain burns (2000 UNI) accordingly
    migrations.set(3, (db: Database.Database) => {
      console.log('Running migration 3: add chain column');
      // Table may not exist yet on a fresh install — it will be created with the column included
      const tableExists = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='token_transfers'"
      ).get();
      if (!tableExists) {
        console.log('Migration 3: table not yet created, skipping (column included in CREATE TABLE)');
        return;
      }
      // Column may already exist if migration was partially applied
      const tableInfo = db.prepare('PRAGMA table_info(token_transfers)').all() as Array<{ name: string }>;
      if (tableInfo.some(col => col.name === 'chain')) {
        console.log('Migration 3: chain column already exists, skipping');
        return;
      }
      db.exec(`ALTER TABLE token_transfers ADD COLUMN chain TEXT NOT NULL DEFAULT 'mainnet'`);
      // Records with value = 2000 * 10^18 were Unichain burns detected via L1 bridge
      db.exec(`UPDATE token_transfers SET chain = 'unichain' WHERE value = '2000000000000000000000'`);
      console.log('Migration 3 completed');
    });

    return migrations;
  }

  private runMigrations(): void {
    const currentVersion = this.getSchemaVersion();

    if (currentVersion >= CURRENT_SCHEMA_VERSION) {
      return; // Already up to date
    }

    const migrations = this.getMigrations();

    // Run migrations in order
    for (let version = currentVersion + 1; version <= CURRENT_SCHEMA_VERSION; version++) {
      const migration = migrations.get(version);
      if (migration) {
        console.log(`Applying migration ${version}...`);
        migration(this.db);
        this.setSchemaVersion(version);
      } else {
        // No migration needed for this version, just update version number
        this.setSchemaVersion(version);
      }
    }

    console.log(`Database schema is now at version ${CURRENT_SCHEMA_VERSION}`);
  }

  private initializeSchema(): void {
    // Run any pending migrations first
    this.runMigrations();

    // Create table if it doesn't exist (for fresh installs)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS token_transfers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tx_hash TEXT UNIQUE NOT NULL,
        block_number INTEGER NOT NULL,
        token_address TEXT NOT NULL,
        from_address TEXT NOT NULL,
        to_address TEXT NOT NULL,
        burner_address TEXT,
        value TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        gas_used INTEGER,
        gas_price TEXT,
        chain TEXT NOT NULL DEFAULT 'mainnet',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_tx_hash ON token_transfers(tx_hash);
      CREATE INDEX IF NOT EXISTS idx_block_number ON token_transfers(block_number);
      CREATE INDEX IF NOT EXISTS idx_token_address ON token_transfers(token_address);
      CREATE INDEX IF NOT EXISTS idx_to_address ON token_transfers(to_address);
      CREATE INDEX IF NOT EXISTS idx_burner_address ON token_transfers(burner_address);
    `);

    // Set schema version if this is a fresh install
    if (this.getSchemaVersion() === 0) {
      this.setSchemaVersion(CURRENT_SCHEMA_VERSION);
    }
  }

  transferExists(txHash: string): boolean {
    const stmt = this.db.prepare('SELECT 1 FROM token_transfers WHERE tx_hash = ?');
    const result = stmt.get(txHash);
    return result !== undefined;
  }

  addTransfer(transfer: TokenTransfer): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO token_transfers (
        tx_hash, block_number, token_address, from_address, to_address, burner_address,
        value, timestamp, gas_used, gas_price, chain
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      transfer.hash,
      transfer.blockNumber,
      transfer.tokenAddress,
      transfer.from,
      transfer.to,
      transfer.burnerAddress || null,
      transfer.value.toString(),
      transfer.timestamp.toISOString(),
      transfer.gasUsed || null,
      transfer.gasPrice?.toString() || null,
      transfer.chain || 'mainnet'
    );
  }

  getTransferHistory(tokenAddress?: string, recipientAddress?: string, limit: number = 10): TokenTransfer[] {
    let query = 'SELECT * FROM token_transfers';
    const conditions: string[] = [];
    const params: any[] = [];

    if (tokenAddress) {
      conditions.push('token_address = ?');
      params.push(tokenAddress);
    }

    if (recipientAddress) {
      conditions.push('to_address = ?');
      params.push(recipientAddress);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY block_number DESC LIMIT ?';
    params.push(limit);

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];

    return rows.map(row => ({
      hash: row.tx_hash,
      blockNumber: row.block_number,
      tokenAddress: row.token_address,
      from: row.from_address,
      to: row.to_address,
      value: BigInt(row.value),
      timestamp: new Date(row.timestamp),
      gasUsed: row.gas_used,
      gasPrice: row.gas_price ? BigInt(row.gas_price) : undefined,
      status: row.status,
      burnerAddress: row.burner_address,
    }));
  }

  getBurnerStats(burnerAddress: string): { count: number; rank: number; totalBurners: number } {
    // Get count for this burner
    const countStmt = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM token_transfers
      WHERE burner_address = ?
    `);
    const countResult = countStmt.get(burnerAddress) as { count: number };
    const count = countResult.count;

    // Get total number of unique burners
    const totalStmt = this.db.prepare(`
      SELECT COUNT(DISTINCT burner_address) as total
      FROM token_transfers
      WHERE burner_address IS NOT NULL
    `);
    const totalResult = totalStmt.get() as { total: number };
    const totalBurners = totalResult.total;

    // Get rank by counting how many distinct burners have more transactions
    const rankStmt = this.db.prepare(`
      WITH burner_counts AS (
        SELECT
          burner_address,
          COUNT(*) as tx_count
        FROM token_transfers
        WHERE burner_address IS NOT NULL
        GROUP BY burner_address
      )
      SELECT COUNT(*) + 1 as rank
      FROM burner_counts
      WHERE tx_count > (SELECT tx_count FROM burner_counts WHERE burner_address = ?)
    `);
    const rankResult = rankStmt.get(burnerAddress) as { rank: number };
    const rank = rankResult.rank;

    return { count, rank, totalBurners };
  }

  getTransferCount(tokenAddress?: string, recipientAddress?: string): number {
    let query = 'SELECT COUNT(*) as count FROM token_transfers';
    const conditions: string[] = [];
    const params: any[] = [];

    if (tokenAddress) {
      conditions.push('token_address = ?');
      params.push(tokenAddress);
    }

    if (recipientAddress) {
      conditions.push('to_address = ?');
      params.push(recipientAddress);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    const stmt = this.db.prepare(query);
    const result = stmt.get(...params) as { count: number };
    return result.count;
  }

  getPreviousTransferTimestamp(currentHash: string, currentTimestamp: Date): Date | null {
    // Get the transfer that came before this one chronologically
    const stmt = this.db.prepare(`
      SELECT timestamp
      FROM token_transfers
      WHERE tx_hash != ?
        AND (block_number < (SELECT block_number FROM token_transfers WHERE tx_hash = ?)
          OR (block_number = (SELECT block_number FROM token_transfers WHERE tx_hash = ?)
              AND timestamp < ?))
      ORDER BY block_number DESC, timestamp DESC
      LIMIT 1
    `);
    const result = stmt.get(currentHash, currentHash, currentHash, currentTimestamp.toISOString()) as { timestamp: string } | undefined;
    return result ? new Date(result.timestamp) : null;
  }

  getAverageTimeBetweenTransfers(): number | null {
    // Get all timestamps ordered by block number
    const stmt = this.db.prepare(`
      SELECT timestamp
      FROM token_transfers
      ORDER BY block_number ASC
    `);
    const rows = stmt.all() as { timestamp: string }[];

    if (rows.length < 2) {
      return null; // Need at least 2 transfers to calculate average
    }

    let totalDiff = 0;
    for (let i = 1; i < rows.length; i++) {
      const prevTime = new Date(rows[i - 1].timestamp).getTime();
      const currTime = new Date(rows[i].timestamp).getTime();
      totalDiff += currTime - prevTime;
    }

    return totalDiff / (rows.length - 1); // Average in milliseconds
  }

  getTotalTokensSent(): bigint {
    // SQLite doesn't handle very large integers well, so we need to sum them in JavaScript
    const stmt = this.db.prepare(`
      SELECT value
      FROM token_transfers
    `);
    const rows = stmt.all() as Array<{ value: string }>;

    let total = BigInt(0);
    for (const row of rows) {
      total += BigInt(row.value);
    }

    return total;
  }

  getTopBurners(limit: number = 3, chain?: string): Array<{ address: string; count: number }> {
    const stmt = chain
      ? this.db.prepare(`
          SELECT burner_address as address, COUNT(*) as count
          FROM token_transfers
          WHERE burner_address IS NOT NULL AND chain = ?
          GROUP BY burner_address ORDER BY count DESC LIMIT ?
        `)
      : this.db.prepare(`
          SELECT burner_address as address, COUNT(*) as count
          FROM token_transfers
          WHERE burner_address IS NOT NULL
          GROUP BY burner_address ORDER BY count DESC LIMIT ?
        `);
    return (chain ? stmt.all(chain, limit) : stmt.all(limit)) as Array<{ address: string; count: number }>;
  }

  getTotalBurners(chain?: string): number {
    const stmt = chain
      ? this.db.prepare(`SELECT COUNT(DISTINCT burner_address) as total FROM token_transfers WHERE burner_address IS NOT NULL AND chain = ?`)
      : this.db.prepare(`SELECT COUNT(DISTINCT burner_address) as total FROM token_transfers WHERE burner_address IS NOT NULL`);
    const result = (chain ? stmt.get(chain) : stmt.get()) as { total: number };
    return result.total;
  }

  /**
   * Get daily 7-day moving averages of time between transactions
   * Returns an array starting from the first day with a transaction (if < 30 days),
   * or the last 30 days (if >= 30 days), up to today
   */
  getDaily7DayMovingAverage(maxDays: number = 30): Array<{ date: Date; movingAverageHours: number | null }> {
    // Get all transfers ordered by timestamp
    const stmt = this.db.prepare(`
      SELECT timestamp
      FROM token_transfers
      ORDER BY block_number ASC, timestamp ASC
    `);
    const rows = stmt.all() as Array<{ timestamp: string }>;

    if (rows.length < 2) {
      // Not enough data for moving average
      return [];
    }

    // Convert to Date objects
    const transfers = rows.map(row => new Date(row.timestamp));

    // Find the first transaction date
    const firstTransfer = transfers[0];
    const firstDate = new Date(firstTransfer);
    firstDate.setHours(0, 0, 0, 0); // Start of first day

    // Today's date
    const today = new Date();
    today.setHours(23, 59, 59, 999); // End of today

    // Calculate the number of days from first transaction to today
    const daysDiff = Math.ceil((today.getTime() - firstDate.getTime()) / (1000 * 60 * 60 * 24));

    // Determine start date:
    // - If less than maxDays, start from first transaction
    // - If maxDays or more, start from (today - maxDays + 1) to show last maxDays days
    let startDate: Date;
    if (daysDiff < maxDays) {
      // Less than maxDays of history, start from first transaction
      startDate = new Date(firstDate);
    } else {
      // More than maxDays of history, show last maxDays days (going backward from today)
      startDate = new Date(today);
      startDate.setDate(startDate.getDate() - (maxDays - 1));
      startDate.setHours(0, 0, 0, 0);
    }

    const actualDays = Math.min(daysDiff + 1, maxDays);

    if (actualDays <= 0) {
      return [];
    }

    const dailyData: Array<{ date: Date; movingAverageHours: number | null }> = [];

    // Generate data for each day from startDate to today
    for (let i = 0; i < actualDays; i++) {
      const targetDate = new Date(startDate);
      targetDate.setDate(targetDate.getDate() + i);
      const endOfDay = new Date(targetDate);
      endOfDay.setHours(23, 59, 59, 999);

      // If we've gone past today, stop
      if (endOfDay > today) {
        break;
      }

      // Find all transfers up to end of this day
      const transfersUpToDate = transfers.filter(t => t <= endOfDay);

      if (transfersUpToDate.length < 2) {
        dailyData.push({ date: targetDate, movingAverageHours: null });
        continue;
      }

      // Calculate 7-day window
      const windowStart = new Date(endOfDay);
      windowStart.setDate(windowStart.getDate() - 7);
      windowStart.setHours(0, 0, 0, 0);

      // Find transfers within the 7-day window
      const transfersInWindow = transfersUpToDate.filter(t => t >= windowStart);

      if (transfersInWindow.length < 2) {
        dailyData.push({ date: targetDate, movingAverageHours: null });
        continue;
      }

      // Calculate time differences within the 7-day window
      const diffsInWindow: number[] = [];
      for (let j = 1; j < transfersInWindow.length; j++) {
        diffsInWindow.push(transfersInWindow[j].getTime() - transfersInWindow[j - 1].getTime());
      }

      if (diffsInWindow.length === 0) {
        dailyData.push({ date: targetDate, movingAverageHours: null });
        continue;
      }

      // Calculate average (in milliseconds), then convert to hours
      const avgMs = diffsInWindow.reduce((sum, diff) => sum + diff, 0) / diffsInWindow.length;
      const avgHours = avgMs / (1000 * 60 * 60);

      dailyData.push({ date: targetDate, movingAverageHours: avgHours });
    }

    return dailyData;
  }

  getTransferCountByChain(chain: string): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM token_transfers WHERE chain = ?');
    const result = stmt.get(chain) as { count: number };
    return result.count;
  }

  getChainBreakdown(): Array<{ chain: string; totalUNI: bigint; totalTransactions: number }> {
    const stmt = this.db.prepare(`
      SELECT chain, value
      FROM token_transfers
      ORDER BY chain
    `);
    const rows = stmt.all() as Array<{ chain: string; value: string }>;

    const breakdown = new Map<string, { totalUNI: bigint; totalTransactions: number }>();
    for (const row of rows) {
      const entry = breakdown.get(row.chain) || { totalUNI: BigInt(0), totalTransactions: 0 };
      entry.totalUNI += BigInt(row.value);
      entry.totalTransactions += 1;
      breakdown.set(row.chain, entry);
    }

    return Array.from(breakdown.entries())
      .map(([chain, stats]) => ({ chain, ...stats }))
      .sort((a, b) => Number(b.totalUNI - a.totalUNI));
  }

  /**
   * Get daily 7-day and 30-day moving averages of UNI burnt per day.
   * Returns the last chartDays days (or fewer if less history exists).
   */
  getDailyBurnMovingAverages(tokenDecimals: number = 18, chartDays: number = 30): Array<{ date: Date; ma7: number | null; ma30: number | null }> {
    const divisor = BigInt(10 ** tokenDecimals);

    const stmt = this.db.prepare(`
      SELECT timestamp, value
      FROM token_transfers
      ORDER BY timestamp ASC
    `);
    const rows = stmt.all() as Array<{ timestamp: string; value: string }>;

    if (rows.length === 0) return [];

    // Build a map of YYYY-MM-DD -> total UNI burnt (integer tokens)
    const dailySums = new Map<string, number>();
    let firstDateKey: string | null = null;

    for (const row of rows) {
      const dateKey = new Date(row.timestamp).toISOString().slice(0, 10);
      if (!firstDateKey) firstDateKey = dateKey;
      const uniAmount = Number(BigInt(row.value) / divisor);
      dailySums.set(dateKey, (dailySums.get(dateKey) || 0) + uniAmount);
    }

    if (!firstDateKey) return [];

    // Build array of every day from first transaction to today (UTC noon to avoid DST issues)
    const allDays: Array<{ dateKey: string; uni: number }> = [];
    const curDate = new Date(firstDateKey + 'T12:00:00Z');
    const todayUTC = new Date();
    todayUTC.setUTCHours(12, 0, 0, 0);

    while (curDate <= todayUTC) {
      const dateKey = curDate.toISOString().slice(0, 10);
      allDays.push({ dateKey, uni: dailySums.get(dateKey) || 0 });
      curDate.setUTCDate(curDate.getUTCDate() + 1);
    }

    // Return the last chartDays days with their MAs
    const chartStartIdx = Math.max(0, allDays.length - chartDays);
    const result: Array<{ date: Date; ma7: number | null; ma30: number | null }> = [];

    for (let i = chartStartIdx; i < allDays.length; i++) {
      const date = new Date(allDays[i].dateKey + 'T12:00:00Z');

      let ma7: number | null = null;
      if (i >= 6) {
        const slice = allDays.slice(i - 6, i + 1);
        ma7 = slice.reduce((sum, d) => sum + d.uni, 0) / 7;
      }

      let ma30: number | null = null;
      if (i >= 29) {
        const slice = allDays.slice(i - 29, i + 1);
        ma30 = slice.reduce((sum, d) => sum + d.uni, 0) / 30;
      }

      result.push({ date, ma7, ma30 });
    }

    return result;
  }

  close(): void {
    this.db.close();
  }
}

