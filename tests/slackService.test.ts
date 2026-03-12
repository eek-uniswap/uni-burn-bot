import { SlackService } from '../src/slackService';
import { TokenTransfer } from '../src/types';

// Mock the Slack WebClient
const mockPostMessage = jest.fn().mockResolvedValue({ ts: '1234567890.123456' });

jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    chat: {
      postMessage: mockPostMessage,
    },
  })),
}));

describe('SlackService', () => {
  let slackService: SlackService;
  const mockBotToken = 'xoxb-test-token';
  const mockChannel = '#test-channel';

  beforeEach(() => {
    jest.clearAllMocks();
    slackService = new SlackService(mockBotToken, mockChannel);
  });

  describe('formatTokenAmount', () => {
    it('should format token amount with 18 decimals', () => {
      const service = new SlackService(mockBotToken, mockChannel, 18);
      const burns: TokenTransfer[] = [
        {
          hash: '0x123',
          blockNumber: 1000,
          tokenAddress: '0xtoken',
          from: '0xfrom',
          to: '0xto',
          value: BigInt('1000000000000000000'), // 1 token
          timestamp: new Date(),
        },
      ];

      const blocks = (service as any).formatDigestBlocks(
        new Date('2025-01-01T00:00:00Z'),
        new Date('2025-01-01T04:00:00Z'),
        burns,
        {
          totalTokens: BigInt('1000000000000000000'),
          currentMa7: null,
          currentMa30: null,
          chainBreakdown: [],
        }
      );

      // Check that total burned amount appears in the blocks
      const allText = JSON.stringify(blocks);
      expect(allText).toContain('Total Burned');
      expect(allText).toContain('1 UNI');
    });
  });

  describe('formatTimeDifference', () => {
    it('should format seconds correctly', () => {
      const service = new SlackService(mockBotToken, mockChannel);
      const formatted = (service as any).formatTimeDifference(45 * 1000);
      expect(formatted).toBe('45s');
    });

    it('should format minutes and seconds correctly', () => {
      const service = new SlackService(mockBotToken, mockChannel);
      const formatted = (service as any).formatTimeDifference(125 * 1000);
      expect(formatted).toBe('2m 5s');
    });

    it('should format hours, minutes and seconds correctly', () => {
      const service = new SlackService(mockBotToken, mockChannel);
      const formatted = (service as any).formatTimeDifference(3665 * 1000);
      expect(formatted).toBe('1h 1m 5s');
    });

    it('should format days, hours and minutes correctly', () => {
      const service = new SlackService(mockBotToken, mockChannel);
      const formatted = (service as any).formatTimeDifference(90000 * 1000);
      expect(formatted).toBe('1d 1h 0m');
    });
  });

  describe('sendDigest', () => {
    const windowStart = new Date('2025-01-01T00:00:00Z');
    const windowEnd = new Date('2025-01-01T04:00:00Z');

    const aggregateStats = {
      totalTokens: BigInt('4000000000000000000000'),
      currentMa7: null,
      currentMa30: null,
      chainBreakdown: [],
    };

    it('should send a message when there are burns in the window', async () => {
      const burns: TokenTransfer[] = [
        {
          hash: '0xabc123',
          blockNumber: 1000,
          tokenAddress: '0xtoken',
          from: '0xfrom',
          to: '0xto',
          value: BigInt('4000000000000000000000'),
          timestamp: new Date('2025-01-01T02:00:00Z'),
          burnerAddress: '0xburner',
          chain: 'mainnet',
        },
      ];

      await slackService.sendDigest(windowStart, windowEnd, burns, aggregateStats);

      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: mockChannel,
          blocks: expect.any(Array),
          unfurl_links: false,
          unfurl_media: false,
        })
      );

      const blocks = mockPostMessage.mock.calls[0][0].blocks;
      const allText = JSON.stringify(blocks);
      expect(allText).toContain('UNI Burn Report');
      expect(allText).toContain('1 burn');
      expect(allText).toContain('4,000 UNI');
    });

    it('should send a "no burns" message for an empty window', async () => {
      await slackService.sendDigest(windowStart, windowEnd, [], aggregateStats);

      expect(mockPostMessage).toHaveBeenCalled();
      const blocks = mockPostMessage.mock.calls[0][0].blocks;
      const allText = JSON.stringify(blocks);
      expect(allText).toContain('No burns in this period');
    });

    it('should include 7d and 30d MA when available', async () => {
      await slackService.sendDigest(windowStart, windowEnd, [], {
        ...aggregateStats,
        currentMa7: 8000,
        currentMa30: 6500,
      });

      const blocks = mockPostMessage.mock.calls[0][0].blocks;
      const allText = JSON.stringify(blocks);
      expect(allText).toContain('8,000 UNI/day');
      expect(allText).toContain('6,500 UNI/day');
    });

    it('should show per-chain breakdown when multiple chains present', async () => {
      await slackService.sendDigest(windowStart, windowEnd, [], {
        ...aggregateStats,
        chainBreakdown: [
          { chain: 'mainnet', totalUNI: BigInt('4000000000000000000000'), totalTransactions: 1 },
          { chain: 'unichain', totalUNI: BigInt('2000000000000000000000'), totalTransactions: 1 },
        ],
      });

      const blocks = mockPostMessage.mock.calls[0][0].blocks;
      const allText = JSON.stringify(blocks);
      expect(allText).toContain('By Chain');
      expect(allText).toContain('Mainnet');
      expect(allText).toContain('Unichain');
    });
  });
});
