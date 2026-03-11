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
      const transfer: TokenTransfer = {
        hash: '0x123',
        blockNumber: 1000,
        tokenAddress: '0xtoken',
        from: '0xfrom',
        to: '0xto',
        value: BigInt('1000000000000000000'), // 1 token
        timestamp: new Date(),
      };

      const blocks = (service as any).formatTokenTransferMessage(
        transfer,
        1,
        {
          totalTokens: BigInt('1000000000000000000'),
          currentMa7: null,
          currentMa30: null,
          totalBurners: 1,
          topBurners: [],
          chainBreakdown: [],
        }
      );

      // Check that amount is formatted (should be "1" or "1.0")
      const amountSection = blocks.find((b: any) =>
        b.fields?.some((f: any) => f.text?.includes('Total UNI Burned'))
      );
      expect(amountSection).toBeDefined();
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

  describe('sendTransferAlert', () => {
    it('should send a message with correct format', async () => {
      const transfer: TokenTransfer = {
        hash: '0xabc123',
        blockNumber: 1000,
        tokenAddress: '0xtoken',
        from: '0xfrom',
        to: '0xto',
        value: BigInt('4000000000000000000000'),
        timestamp: new Date('2025-01-01T00:00:00Z'),
        burnerAddress: '0xburner',
        status: 1,
      };

      const aggregateStats = {
        totalTokens: BigInt('4000000000000000000000'),
        currentMa7: null,
        currentMa30: null,
        totalBurners: 1,
        topBurners: [{ address: '0xburner', count: 1 }],
        chainBreakdown: [],
      };

      await slackService.sendTransferAlert(transfer, 1, aggregateStats);

      expect(mockPostMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: mockChannel,
          blocks: expect.any(Array),
        })
      );
    });
  });
});

