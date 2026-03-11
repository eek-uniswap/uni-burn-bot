import * as dotenv from 'dotenv';
import * as path from 'path';
import { TransactionDatabase } from './database';
import { EthereumMonitor } from './ethereumMonitor';
import { L2BurnMonitor } from './l2BurnMonitor';
import { SlackService } from './slackService';
import { Config, L2ChainConfig } from './types';

// Hardcoded L2 chain configs — RPC URLs come from env vars, contract addresses are fixed
const L2_CHAIN_CONFIGS: Omit<L2ChainConfig, 'rpcUrl'>[] = [
  {
    name: 'unichain',
    firepitAddress: '0xe0A780E9105aC10Ee304448224Eb4A2b11A77eeB',
    uniTokenAddress: '0x8f187aA05619a017077f5308904739877ce9eA21',
    secondsPerBlock: 1,
  },
  {
    name: 'base',
    firepitAddress: '0xff77c0ed0b6b13a20446969107e5867abc46f53a',
    uniTokenAddress: '0xc3De830EA07524a0761646a6a4e4be0e114a3C83',
    secondsPerBlock: 2,
  },
  {
    name: 'optimism',
    firepitAddress: '0x94460443ca27ffc1baeca61165fde18346c91abd',
    uniTokenAddress: '0x6fd9d7AD17242c41f7131d257212c54A0e816691',
    secondsPerBlock: 2,
  },
  {
    name: 'arbitrum',
    firepitAddress: '0xb8018422bce25d82e70cb98fda96a4f502d89427',
    uniTokenAddress: '0xFa7F8980b0f1E64A2062791cc3b0871572f1F7f0',
    secondsPerBlock: 0.25,
  },
];

// Load .env file from project root (works with both ts-node and compiled JS)
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function loadConfig(): Config {
  const ethereumRpcUrl = process.env.ETHEREUM_RPC_URL?.trim();
  const tokenAddress = process.env.TOKEN_ADDRESS?.trim();
  const recipientAddress = process.env.RECIPIENT_ADDRESS?.trim();
  const amount = process.env.AMOUNT?.trim();
  const tokenDecimals = process.env.TOKEN_DECIMALS ? parseInt(process.env.TOKEN_DECIMALS.trim(), 10) : 18;
  const slackBotToken = process.env.SLACK_BOT_TOKEN?.trim();
  const slackChannel = process.env.SLACK_CHANNEL?.trim().replace(/^#+/, '#');
  const pollInterval = parseInt(process.env.POLL_INTERVAL?.trim() || '30', 10);

  if (!ethereumRpcUrl || !tokenAddress || !recipientAddress || !amount || !slackBotToken || !slackChannel) {
    console.error('Missing required environment variables. Please check your .env file.');
    console.error('Required: ETHEREUM_RPC_URL, TOKEN_ADDRESS, RECIPIENT_ADDRESS, AMOUNT, SLACK_BOT_TOKEN, SLACK_CHANNEL');
    process.exit(1);
  }

  // Build L2 chain configs from env vars — only include chains with an RPC URL configured
  const l2RpcEnvVars: Record<string, string> = {
    unichain: 'UNICHAIN_RPC_URL',
    base: 'BASE_RPC_URL',
    optimism: 'OPTIMISM_RPC_URL',
    arbitrum: 'ARBITRUM_RPC_URL',
  };

  const l2Chains: L2ChainConfig[] = L2_CHAIN_CONFIGS
    .map(cfg => {
      const rpcUrl = process.env[l2RpcEnvVars[cfg.name]]?.trim();
      return rpcUrl ? { ...cfg, rpcUrl } : null;
    })
    .filter((cfg): cfg is L2ChainConfig => cfg !== null);

  if (l2Chains.length > 0) {
    console.log(`L2 chains configured: ${l2Chains.map(c => c.name).join(', ')}`);
  } else {
    console.log('No L2 chains configured. Set UNICHAIN_RPC_URL, BASE_RPC_URL, OPTIMISM_RPC_URL, ARBITRUM_RPC_URL to enable L2 monitoring.');
  }

  return {
    ethereumRpcUrl,
    tokenAddress,
    recipientAddress,
    amount,
    amounts: [amount], // Mainnet only — L2 chains handled by L2BurnMonitor
    tokenDecimals,
    slackBotToken,
    slackChannel,
    pollInterval,
    l2Chains,
  };
}

async function main(): Promise<void> {
  const config = loadConfig();

  // Initialize services
  let db: TransactionDatabase;
  let monitor: EthereumMonitor;
  let l2Monitors: L2BurnMonitor[];
  let slack: SlackService;

  try {
    const dbPath = process.env.DATABASE_PATH || 'transactions.db';
    db = new TransactionDatabase(dbPath);
    monitor = new EthereumMonitor(
      config.ethereumRpcUrl,
      config.tokenAddress,
      config.recipientAddress,
      config.amounts
    );
    await monitor.initialize();

    l2Monitors = config.l2Chains.map(chainCfg => new L2BurnMonitor(chainCfg));
    await Promise.all(l2Monitors.map(m => m.initialize()));

    slack = new SlackService(config.slackBotToken, config.slackChannel, config.tokenDecimals);
  } catch (error: any) {
    console.error(`Failed to initialize services:`, error.message);
    process.exit(1);
  }

  console.log('Bot started. Monitoring for token transfers...');
  console.log(`Polling interval: ${config.pollInterval} seconds`);

  // Helper: build aggregate stats and send Slack alert for a transfer
  async function processTransfer(transfer: import('./types').TokenTransfer): Promise<void> {
    db.addTransfer(transfer);
    console.log(`Stored transfer: ${transfer.hash} (${transfer.chain ?? 'mainnet'})`);

    const burnerAddress = transfer.burnerAddress || transfer.from;
    const burnerStats = db.getBurnerStats(burnerAddress);

    const chain = transfer.chain ?? 'mainnet';
    const maData = db.getDailyBurnMovingAverages(config.tokenDecimals, 30);
    const currentMa7 = maData.filter(d => d.ma7 !== null).slice(-1)[0]?.ma7 ?? null;
    const currentMa30 = maData.filter(d => d.ma30 !== null).slice(-1)[0]?.ma30 ?? null;

    const aggregateStats = {
      totalTokens: db.getTotalTokensSent(),
      currentMa7,
      currentMa30,
      totalBurners: db.getTotalBurners(chain),
      topBurners: db.getTopBurners(3, chain),
      chainBreakdown: db.getChainBreakdown(),
    };

    try {
      await slack.sendTransferAlert(transfer, burnerStats.count, aggregateStats);
      console.log(`Sent alert for transfer: ${transfer.hash}`);
    } catch (error: any) {
      console.error(`Failed to send Slack alert:`, error.message);
    }
  }

  // Per-chain historical backfill — only runs if a chain has no records yet
  const chainStartDates: Record<string, Date> = {
    mainnet:  new Date('2025-12-27T17:00:00Z'),
    unichain: new Date('2025-12-27T17:00:00Z'),
    base:     new Date('2026-03-07T00:00:00Z'),
    optimism: new Date('2026-03-07T00:00:00Z'),
    arbitrum: new Date('2026-03-07T00:00:00Z'),
  };

  const backfillChain = async (
    chainName: string,
    getHistorical: (startDate: Date) => Promise<import('./types').TokenTransfer[]>
  ) => {
    const existingCount = db.getTransferCountByChain(chainName);
    if (existingCount > 0) return;

    const startDate = chainStartDates[chainName] ?? new Date('2026-03-07T00:00:00Z');
    console.log(`[${chainName}] No records found — backfilling from ${startDate.toISOString()}...`);
    try {
      const transfers = await getHistorical(startDate);
      console.log(`[${chainName}] Found ${transfers.length} historical transfer(s)`);
      for (const t of transfers) {
        if (!db.transferExists(t.hash)) db.addTransfer(t);
      }
      if (transfers.length > 0) {
        const mostRecent = transfers.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0];
        await processTransfer(mostRecent);
      }
    } catch (error: any) {
      console.error(`[${chainName}] Error during backfill:`, error.message);
    }
  };

  await Promise.all([
    backfillChain('mainnet', (d) => monitor.getHistoricalTransfers(d)),
    ...l2Monitors.map(m => backfillChain(m.chainName, (d) => m.getHistoricalTransfers(d))),
  ]);

  // Graceful shutdown handler
  const shutdown = () => {
    console.log('\nBot stopped by user');
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Main monitoring loop — poll all chains in parallel each interval
  while (true) {
    try {
      const allNewTransfers = (await Promise.all([
        monitor.checkForNewTransfers(),
        ...l2Monitors.map(m => m.checkForNewTransfers()),
      ])).flat();

      if (allNewTransfers.length > 0) {
        console.log(`Found ${allNewTransfers.length} new transfer(s) across all chains`);
        for (const transfer of allNewTransfers) {
          if (!db.transferExists(transfer.hash)) {
            await processTransfer(transfer);
          } else {
            console.log(`Transfer already exists: ${transfer.hash}`);
          }
        }
      }
    } catch (error: any) {
      console.error(`Error in monitoring loop:`, error.message);
    }

    await new Promise((resolve) => setTimeout(resolve, config.pollInterval * 1000));
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

