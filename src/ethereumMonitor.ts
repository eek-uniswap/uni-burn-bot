import { Web3 } from 'web3';
import { TokenTransfer } from './types';

// ERC-20 Transfer event signature: Transfer(address indexed from, address indexed to, uint256 value)
const TRANSFER_EVENT_SIGNATURE = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export class EthereumMonitor {
  private web3: Web3;
  private tokenAddress: string;
  private recipientAddress: string;
  private targetAmounts: bigint[];
  private lastCheckedBlock: number | null = null;

  constructor(rpcUrl: string, tokenAddress: string, recipientAddress: string, amounts: string[]) {
    this.web3 = new Web3(rpcUrl);
    this.tokenAddress = this.web3.utils.toChecksumAddress(tokenAddress);
    this.recipientAddress = this.web3.utils.toChecksumAddress(recipientAddress);
    this.targetAmounts = amounts.map(amount => BigInt(amount));
  }

  async initialize(): Promise<void> {
    // Test connection
    try {
      await this.web3.eth.getBlockNumber();
      console.log(`Connected to Ethereum. Monitoring token: ${this.tokenAddress}`);
      const amountsStr = this.targetAmounts.map(a => a.toString()).join(', ');
      console.log(`Looking for transfers of [${amountsStr}] to ${this.recipientAddress}`);
    } catch (error: any) {
      throw new Error(`Failed to connect to Ethereum RPC endpoint: ${error.message}`);
    }
  }

  async getLatestBlockNumber(): Promise<number> {
    return Number(await this.web3.eth.getBlockNumber());
  }

  private parseTransferEvent(log: any): { from: string; to: string; value: bigint } | null {
    try {
      // Transfer event has 3 topics: [signature, from, to] and data [value]
      if (log.topics.length !== 3 || log.topics[0] !== TRANSFER_EVENT_SIGNATURE) {
        return null;
      }

      const from = this.web3.utils.toChecksumAddress('0x' + log.topics[1].slice(-40));
      const to = this.web3.utils.toChecksumAddress('0x' + log.topics[2].slice(-40));
      const value = BigInt(log.data);

      return { from, to, value };
    } catch (error) {
      return null;
    }
  }

  async scanBlocksForTransfers(startBlock: number, endBlock: number): Promise<TokenTransfer[]> {
    const matchingTransfers: TokenTransfer[] = [];


    try {
      // Get logs for Transfer events from the token contract
      // Filter by recipient address (topic 2)
      const recipientTopic = '0x000000000000000000000000' + this.recipientAddress.slice(2).toLowerCase();

      const logs = await this.web3.eth.getPastLogs({
        fromBlock: startBlock,
        toBlock: endBlock,
        address: this.tokenAddress,
        topics: [
          TRANSFER_EVENT_SIGNATURE, // Event signature
          null, // from (any address)
          recipientTopic, // to (specific recipient)
        ],
      });

      for (const log of logs) {
        // Type guard: ensure log is an object with required properties
        if (typeof log === 'string' || !log.transactionHash || !log.blockNumber) {
          continue;
        }

        const transfer = this.parseTransferEvent(log);
        if (!transfer) continue;

        // Check if the amount matches any of the target amounts
        if (!this.targetAmounts.includes(transfer.value)) {
          continue;
        }

        // Get transaction and block details
        try {
          const txHash = typeof log.transactionHash === 'string' ? log.transactionHash : String(log.transactionHash);
          const blockNum = typeof log.blockNumber === 'number' ? log.blockNumber : Number(log.blockNumber);

          const [tx, receipt, block] = await Promise.all([
            this.web3.eth.getTransaction(txHash),
            this.web3.eth.getTransactionReceipt(txHash),
            this.web3.eth.getBlock(blockNum),
          ]);

          if (!tx || !receipt || !block) continue;

          // Handle status
          let status = 0;
          if (typeof receipt.status === 'boolean') {
            status = receipt.status ? 1 : 0;
          } else if (typeof receipt.status === 'number' || typeof receipt.status === 'bigint') {
            status = Number(receipt.status);
          }

          matchingTransfers.push({
            hash: log.transactionHash,
            blockNumber: Number(log.blockNumber),
            tokenAddress: this.tokenAddress,
            from: transfer.from,
            to: transfer.to,
            value: transfer.value,
            timestamp: new Date(Number(block.timestamp) * 1000),
            gasUsed: Number(receipt.gasUsed),
            gasPrice: tx.gasPrice ? BigInt(tx.gasPrice.toString()) : undefined,
            status,
            burnerAddress: tx.from, // The address that initiated the transaction
          });
        } catch (error: any) {
          console.error(`Error fetching details for tx ${log.transactionHash}:`, error.message);
        }
      }
    } catch (error: any) {
      console.error(`Error scanning blocks ${startBlock}-${endBlock}:`, error.message);
    }

    return matchingTransfers;
  }

  async checkForNewTransfers(): Promise<TokenTransfer[]> {
    const currentBlock = await this.getLatestBlockNumber();

    let startBlock: number;
    if (this.lastCheckedBlock === null) {
      // First run: check last 100 blocks (more for events)
      startBlock = Math.max(0, currentBlock - 100);
      this.lastCheckedBlock = currentBlock;
    } else {
      startBlock = this.lastCheckedBlock + 1;
    }

    if (startBlock > currentBlock) {
      return [];
    }

    const newTransfers = await this.scanBlocksForTransfers(startBlock, currentBlock);
    this.lastCheckedBlock = currentBlock;

    return newTransfers;
  }

  async getBlockNumberForDate(targetDate: Date): Promise<number> {
    // Convert target date to Unix timestamp
    const targetTimestamp = Math.floor(targetDate.getTime() / 1000);
    const currentBlock = await this.getLatestBlockNumber();

    // Get current block to estimate
    const currentBlockData = await this.web3.eth.getBlock(currentBlock);
    const currentTimestamp = Number(currentBlockData.timestamp);

    // Estimate block number (Ethereum averages ~12 seconds per block)
    const secondsPerBlock = 12;
    const secondsDiff = currentTimestamp - targetTimestamp;
    const estimatedBlocksBack = Math.floor(secondsDiff / secondsPerBlock);
    let estimatedBlock = Math.max(0, currentBlock - estimatedBlocksBack);

    // Binary search to find the exact block
    let low = Math.max(0, estimatedBlock - 1000);
    let high = Math.min(currentBlock, estimatedBlock + 1000);
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
      } catch (error) {
        // If block doesn't exist, adjust search
        if (mid < estimatedBlock) {
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
    }

    return bestBlock;
  }

  async getHistoricalTransfers(startDate: Date): Promise<TokenTransfer[]> {
    const currentBlock = await this.getLatestBlockNumber();
    const startBlock = await this.getBlockNumberForDate(startDate);

    console.log(`Fetching historical transfers from ${startDate.toISOString()} (blocks ${startBlock} to ${currentBlock})`);

    return await this.scanBlocksForTransfers(startBlock, currentBlock);
  }
}

