import { Web3 } from 'web3';
import { TokenTransfer, L2ChainConfig } from './types';

// Released(uint256 indexed nonce, address indexed recipient, Currency[] assets)
// Currency is a custom type wrapping address, so ABI-encoded as address[]
const RELEASED_EVENT_TOPIC = '0x0143172ff1dd87f3691e870b3fb5616db820278d26d2d16c3e03330a240a6c38';

// threshold() function selector
const THRESHOLD_SELECTOR = '0x42cde4e8';

const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD';
const DEFAULT_THRESHOLD = BigInt('2000000000000000000000'); // 2000 UNI

// Max blocks per getPastLogs request — keeps RPC calls manageable
const BLOCK_CHUNK_SIZE = 10000;

// How many blocks to look back on first poll (L2s have faster block times)
const INITIAL_LOOKBACK_BLOCKS: Record<string, number> = {
  arbitrum: 10000, // ~0.25s blocks
  unichain: 1800,  // ~1s blocks
  base: 900,       // ~2s blocks
  optimism: 900,   // ~2s blocks
};

export class L2BurnMonitor {
  private web3: Web3;
  private config: L2ChainConfig;
  private threshold: bigint = DEFAULT_THRESHOLD;
  private lastCheckedBlock: number | null = null;

  readonly chainName: string;

  constructor(config: L2ChainConfig) {
    this.web3 = new Web3(config.rpcUrl);
    this.config = config;
    this.chainName = config.name;
  }

  async initialize(): Promise<void> {
    try {
      await this.web3.eth.getBlockNumber();
      console.log(`[${this.config.name}] Connected. Monitoring firepit: ${this.config.firepitAddress}`);
    } catch (error: any) {
      throw new Error(`[${this.config.name}] Failed to connect to RPC: ${error.message}`);
    }

    // Read threshold from firepit contract
    try {
      const result = await this.web3.eth.call({
        to: this.config.firepitAddress,
        data: THRESHOLD_SELECTOR,
      });
      this.threshold = BigInt(result as string);
      const thresholdUni = this.threshold / BigInt(10 ** 18);
      console.log(`[${this.config.name}] Threshold: ${thresholdUni} UNI`);
    } catch (error: any) {
      console.warn(`[${this.config.name}] Could not read threshold, defaulting to 2000 UNI: ${error.message}`);
    }
  }

  async getLatestBlockNumber(): Promise<number> {
    return Number(await this.web3.eth.getBlockNumber());
  }

  async getBlockNumberForDate(targetDate: Date): Promise<number> {
    const targetTimestamp = Math.floor(targetDate.getTime() / 1000);
    const currentBlock = await this.getLatestBlockNumber();
    const currentBlockData = await this.web3.eth.getBlock(currentBlock);
    const currentTimestamp = Number(currentBlockData.timestamp);

    const secondsDiff = currentTimestamp - targetTimestamp;
    const estimatedBlocksBack = Math.floor(secondsDiff / this.config.secondsPerBlock);
    const estimatedBlock = Math.max(0, currentBlock - estimatedBlocksBack);

    // Binary search with a window of 50k blocks around the estimate
    let low = Math.max(0, estimatedBlock - 50000);
    let high = Math.min(currentBlock, estimatedBlock + 50000);
    let bestBlock = estimatedBlock;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      try {
        const block = await this.web3.eth.getBlock(mid);
        const blockTimestamp = Number(block.timestamp);
        if (blockTimestamp >= targetTimestamp) {
          bestBlock = mid;
          high = mid - 1;
        } else {
          low = mid + 1;
        }
      } catch {
        if (mid < estimatedBlock) low = mid + 1;
        else high = mid - 1;
      }
    }

    return bestBlock;
  }

  async scanBlocksForBurns(startBlock: number, endBlock: number): Promise<TokenTransfer[]> {
    const burns: TokenTransfer[] = [];

    for (let from = startBlock; from <= endBlock; from += BLOCK_CHUNK_SIZE) {
      const to = Math.min(from + BLOCK_CHUNK_SIZE - 1, endBlock);
      try {
        const logs = await this.web3.eth.getPastLogs({
          fromBlock: from,
          toBlock: to,
          address: this.config.firepitAddress,
          topics: [RELEASED_EVENT_TOPIC],
        });

        for (const log of logs) {
          if (typeof log === 'string' || !log.transactionHash || !log.blockNumber) continue;

          try {
            const txHash = String(log.transactionHash);
            const blockNum = Number(log.blockNumber);

            const [tx, receipt, block] = await Promise.all([
              this.web3.eth.getTransaction(txHash),
              this.web3.eth.getTransactionReceipt(txHash),
              this.web3.eth.getBlock(blockNum),
            ]);

            if (!tx || !receipt || !block) continue;

            let status = 0;
            if (typeof receipt.status === 'boolean') {
              status = receipt.status ? 1 : 0;
            } else if (typeof receipt.status === 'number' || typeof receipt.status === 'bigint') {
              status = Number(receipt.status);
            }

            burns.push({
              hash: txHash,
              blockNumber: blockNum,
              tokenAddress: this.config.uniTokenAddress,
              from: this.config.firepitAddress,
              to: BURN_ADDRESS,
              value: this.threshold,
              timestamp: new Date(Number(block.timestamp) * 1000),
              gasUsed: Number(receipt.gasUsed),
              gasPrice: tx.gasPrice ? BigInt(tx.gasPrice.toString()) : undefined,
              status,
              burnerAddress: tx.from,
              chain: this.config.name,
            });
          } catch (error: any) {
            console.error(`[${this.config.name}] Error fetching tx ${log.transactionHash}:`, error.message);
          }
        }
      } catch (error: any) {
        console.error(`[${this.config.name}] Error scanning blocks ${from}-${to}:`, error.message);
      }
    }

    return burns;
  }

  async checkForNewTransfers(): Promise<TokenTransfer[]> {
    const currentBlock = await this.getLatestBlockNumber();

    let startBlock: number;
    if (this.lastCheckedBlock === null) {
      const lookback = INITIAL_LOOKBACK_BLOCKS[this.config.name] ?? 900;
      startBlock = Math.max(0, currentBlock - lookback);
    } else {
      startBlock = this.lastCheckedBlock + 1;
    }

    this.lastCheckedBlock = currentBlock;

    if (startBlock > currentBlock) return [];
    return this.scanBlocksForBurns(startBlock, currentBlock);
  }

  async getHistoricalTransfers(startDate: Date): Promise<TokenTransfer[]> {
    const currentBlock = await this.getLatestBlockNumber();
    const startBlock = await this.getBlockNumberForDate(startDate);
    console.log(`[${this.config.name}] Fetching historical burns from ${startDate.toISOString()} (blocks ${startBlock} to ${currentBlock})`);
    return this.scanBlocksForBurns(startBlock, currentBlock);
  }
}
