import { WebClient } from '@slack/web-api';
import { TokenTransfer } from './types';

export class SlackService {
  private client: WebClient;
  private channel: string;
  private tokenDecimals: number;

  constructor(botToken: string, channel: string, tokenDecimals: number = 18) {
    this.client = new WebClient(botToken);
    this.channel = channel;
    this.tokenDecimals = tokenDecimals;
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

  formatTimeDifference(ms: number): string {
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

  private formatWindowLabel(start: Date, end: Date): string {
    const timeOpts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' };
    const dateOpts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' };
    const startStr = start.toLocaleTimeString('en-US', timeOpts);
    const endStr = end.toLocaleTimeString('en-US', timeOpts);
    const dateStr = end.toLocaleDateString('en-US', dateOpts);
    return `${startStr} – ${endStr} UTC · ${dateStr}`;
  }

  private formatDigestBlocks(
    windowStart: Date,
    windowEnd: Date,
    burns: TokenTransfer[],
    aggregateStats: {
      totalTokens: bigint;
      currentMa7: number | null;
      currentMa30: number | null;
      chainBreakdown: Array<{ chain: string; totalUNI: bigint; totalTransactions: number }>;
    }
  ): any[] {
    const blocks: any[] = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: ':unicorn_face: :fire: UNI Burn Report',
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: this.formatWindowLabel(windowStart, windowEnd),
        },
      },
      { type: 'divider' },
    ];

    // Period burns
    if (burns.length === 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*:clock4: This Period*\nNo burns in this period.',
        },
      });
    } else {
      const windowTotal = burns.reduce((sum, b) => sum + b.value, BigInt(0));
      const burnLines = burns.map(b => {
        const explorer = this.getExplorerUrl(b.chain);
        const txUrl = `${explorer}/tx/${b.hash}`;
        const amount = this.formatTokenAmount(b.value);
        const chain = this.getChainLabel(b.chain);
        return `• ${amount} UNI (${chain}) — <${txUrl}|\`${b.hash.slice(0, 10)}...\`>`;
      }).join('\n');

      const countLabel = `${burns.length} burn${burns.length !== 1 ? 's' : ''}`;
      const totalLabel = `${this.formatTokenAmount(windowTotal)} UNI total`;

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*:clock4: This Period*\n${countLabel} · ${totalLabel}\n\n${burnLines}`,
        },
      });
    }

    blocks.push({ type: 'divider' });

    // All-time stats
    const totalFormatted = this.formatTokenAmount(aggregateStats.totalTokens);
    const ma7 = aggregateStats.currentMa7 !== null
      ? `${Math.round(aggregateStats.currentMa7).toLocaleString('en-US')} UNI/day`
      : 'N/A';
    const ma30 = aggregateStats.currentMa30 !== null
      ? `${Math.round(aggregateStats.currentMa30).toLocaleString('en-US')} UNI/day`
      : 'N/A';

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*:bar_chart: All-Time*',
      },
    });

    blocks.push({
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Total Burned:*\n${totalFormatted} UNI` },
        { type: 'mrkdwn', text: `*7d MA:*\n${ma7}` },
        { type: 'mrkdwn', text: `*30d MA:*\n${ma30}` },
      ],
    });

    // Per-chain breakdown (only if multiple chains)
    if (aggregateStats.chainBreakdown.length > 1) {
      const breakdownText = aggregateStats.chainBreakdown
        .map(({ chain, totalUNI, totalTransactions }) =>
          `*${this.getChainLabel(chain)}:* ${this.formatTokenAmount(totalUNI)} UNI (${totalTransactions.toLocaleString()} burns)`
        )
        .join('\n');

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*:globe_with_meridians: By Chain:*\n${breakdownText}`,
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
        text: 'UNI Burn Report',
        unfurl_links: false,
        unfurl_media: false,
      });

      console.log(`Message sent to ${this.channel}: ${response.ts}`);
    } catch (error: any) {
      console.error(`Error sending message to Slack:`, error.message);
      throw error;
    }
  }

  async sendDigest(
    windowStart: Date,
    windowEnd: Date,
    burns: TokenTransfer[],
    aggregateStats: {
      totalTokens: bigint;
      currentMa7: number | null;
      currentMa30: number | null;
      chainBreakdown: Array<{ chain: string; totalUNI: bigint; totalTransactions: number }>;
    }
  ): Promise<void> {
    const blocks = this.formatDigestBlocks(windowStart, windowEnd, burns, aggregateStats);
    await this.sendMessage(blocks);
  }
}
