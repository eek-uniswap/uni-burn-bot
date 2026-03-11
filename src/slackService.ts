import { WebClient } from '@slack/web-api';
import { TokenTransfer } from './types';

export class SlackService {
  private client: WebClient;
  private channel: string;
  private tokenDecimals: number;
  private monitoredAmounts: bigint[] = [];

  constructor(botToken: string, channel: string, tokenDecimals: number = 18) {
    this.client = new WebClient(botToken);
    this.channel = channel;
    this.tokenDecimals = tokenDecimals;
    this.monitoredAmounts = [];
    console.log(`Slack service initialized for channel: ${this.channel}`);
  }

  private getChainLabel(chain?: string): string {
    const labels: Record<string, string> = {
      mainnet: 'Mainnet',
      unichain: 'Unichain',
      base: 'Base',
      optimism: 'Optimism',
      arbitrum: 'Arbitrum',
    };
    return labels[chain ?? 'mainnet'] ?? (chain ?? 'Unknown');
  }

  private formatTokenAmount(value: bigint): string {
    const divisor = BigInt(10 ** this.tokenDecimals);
    const wholePart = value / divisor;
    const fractionalPart = value % divisor;

    const wholeFormatted = Number(wholePart).toLocaleString('en-US');

    if (fractionalPart === BigInt(0)) {
      return wholeFormatted;
    }

    const fractionalStr = fractionalPart.toString().padStart(this.tokenDecimals, '0');
    const trimmedFractional = fractionalStr.replace(/0+$/, '');
    return `${wholeFormatted}.${trimmedFractional}`;
  }

  private formatTimeDifference(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days}d ${hours % 24}h ${minutes % 60}m`;
    } else if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  private getExplorerUrl(chain?: string): string {
    const explorers: Record<string, string> = {
      mainnet: 'https://etherscan.io',
      unichain: 'https://uniscan.xyz',
      base: 'https://basescan.org',
      optimism: 'https://optimistic.etherscan.io',
      arbitrum: 'https://arbiscan.io',
    };
    return explorers[chain ?? 'mainnet'] ?? 'https://etherscan.io';
  }

  private formatTokenTransferMessage(
    transfer: TokenTransfer,
    burnerCount: number,
    aggregateStats: {
      totalTokens: bigint;
      currentMa7: number | null;
      currentMa30: number | null;
      totalBurners: number;
      topBurners: Array<{ address: string; count: number }>;
      chainBreakdown: Array<{ chain: string; totalUNI: bigint; totalTransactions: number }>;
    }
  ): any[] {
    const explorer = this.getExplorerUrl(transfer.chain);
    const txUrl = `${explorer}/tx/${transfer.hash}`;
    const burnerAddress = transfer.burnerAddress || transfer.from;
    const burnerUrl = `${explorer}/address/${burnerAddress}`;

    const chainLabel = this.getChainLabel(transfer.chain);
    const transferAmountFormatted = this.formatTokenAmount(transfer.value);

    // Build message blocks
    const blocks: any[] = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: ` :unicorn_face: :fire: ${chainLabel} UNI Burn Detected`,
        },
      },
      {
        type: 'divider',
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*📋 Most Recent Transaction*',
        },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: `*Amount:*\n${transferAmountFormatted} UNI (${chainLabel})`,
          },
          {
            type: 'mrkdwn',
            text: `*Burner:*\n<${burnerUrl}|\`${burnerAddress}\`>\n${burnerCount} transaction${burnerCount !== 1 ? 's' : ''}`,
          },
          {
            type: 'mrkdwn',
            text: `*Transaction Hash:*\n<${txUrl}|\`${transfer.hash.slice(0, 10)}...\`>`,
          },
        ],
      },
    ];

    // Add aggregate statistics
    blocks.push({
      type: 'divider',
    });

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*📊 Aggregate Statistics*',
      },
    });

    const totalTokensFormatted = this.formatTokenAmount(aggregateStats.totalTokens);
    const ma7Formatted = aggregateStats.currentMa7 !== null
      ? `${Math.round(aggregateStats.currentMa7).toLocaleString('en-US')} UNI/day`
      : 'N/A';

    blocks.push({
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*Total UNI Burned:*\n${totalTokensFormatted} UNI`,
        },
        {
          type: 'mrkdwn',
          text: `*7-Day MA:*\n${ma7Formatted}`,
        },
        {
          type: 'mrkdwn',
          text: `*30-Day MA:*\n${aggregateStats.currentMa30 !== null ? `${Math.round(aggregateStats.currentMa30).toLocaleString('en-US')} UNI/day` : 'N/A'}`,
        },
        {
          type: 'mrkdwn',
          text: `*Total Burners (${chainLabel}):*\n${aggregateStats.totalBurners.toLocaleString()}`,
        },
      ],
    });

    // Add top 3 burners for this chain
    if (aggregateStats.topBurners.length > 0) {
      const topBurnersText = aggregateStats.topBurners
        .map((burner, index) => {
          const rankEmoji = index === 0 ? '🥇' : index === 1 ? '🥈' : '🥉';
          const burnerUrl = `${explorer}/address/${burner.address}`;
          return `${rankEmoji} <${burnerUrl}|\`${burner.address.slice(0, 10)}...\`> - ${burner.count} burn${burner.count !== 1 ? 's' : ''}`;
        })
        .join('\n');

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Top 3 Burners (${chainLabel}):*\n${topBurnersText}`,
        },
      });
    }

    // Add per-chain breakdown
    if (aggregateStats.chainBreakdown.length > 1) {
      const breakdownText = aggregateStats.chainBreakdown
        .map(({ chain, totalUNI, totalTransactions }) => {
          const uni = this.formatTokenAmount(totalUNI);
          return `*${this.getChainLabel(chain)}:* ${uni} UNI (${totalTransactions.toLocaleString()} burns)`;
        })
        .join('\n');

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*🌐 By Chain:*\n${breakdownText}`,
        },
      });
    }

    return blocks;
  }

  async sendMessage(blocks: any[]): Promise<void> {
    try {
      const response = await this.client.chat.postMessage({
        channel: this.channel,
        blocks,
        text: 'New token transfer detected', // Fallback text
        unfurl_links: false,
        unfurl_media: false,
      });

      console.log(`Message sent to ${this.channel}: ${response.ts}`);
    } catch (error: any) {
      console.error(`Error sending message to Slack:`, error.message);
      throw error;
    }
  }

  private getRankSuffix(rank: number): string {
    if (rank % 100 >= 11 && rank % 100 <= 13) {
      return 'th';
    }
    switch (rank % 10) {
      case 1: return 'st';
      case 2: return 'nd';
      case 3: return 'rd';
      default: return 'th';
    }
  }

  async sendTransferAlert(
    transfer: TokenTransfer,
    burnerCount: number,
    aggregateStats: {
      totalTokens: bigint;
      currentMa7: number | null;
      currentMa30: number | null;
      totalBurners: number;
      topBurners: Array<{ address: string; count: number }>;
      chainBreakdown: Array<{ chain: string; totalUNI: bigint; totalTransactions: number }>;
    }
  ): Promise<void> {
    const blocks = this.formatTokenTransferMessage(transfer, burnerCount, aggregateStats);
    await this.sendMessage(blocks);
  }

}

