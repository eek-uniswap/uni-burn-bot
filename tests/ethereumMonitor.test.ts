import { EthereumMonitor } from '../src/ethereumMonitor';

// Mock web3
jest.mock('web3', () => {
  return {
    Web3: jest.fn().mockImplementation(() => ({
      utils: {
        toChecksumAddress: jest.fn((addr: string) => addr),
      },
      eth: {
        getBlockNumber: jest.fn().mockResolvedValue(1000000),
        getBlock: jest.fn().mockResolvedValue({
          timestamp: BigInt(1704067200), // 2025-01-01 00:00:00 UTC
          transactions: [],
        }),
        getPastLogs: jest.fn().mockResolvedValue([]),
        getTransaction: jest.fn(),
        getTransactionReceipt: jest.fn(),
      },
    })),
  };
});

describe('EthereumMonitor', () => {
  let monitor: EthereumMonitor;
  const mockRpcUrl = 'https://mainnet.infura.io/v3/test';
  const mockTokenAddress = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984';
  const mockRecipientAddress = '0x000000000000000000000000000000000000dEaD';
  const mockAmounts = ['4000000000000000000000'];

  beforeEach(() => {
    monitor = new EthereumMonitor(
      mockRpcUrl,
      mockTokenAddress,
      mockRecipientAddress,
      mockAmounts
    );
  });

  describe('initialize', () => {
    it('should connect to Ethereum and log success', async () => {
      await expect(monitor.initialize()).resolves.not.toThrow();
    });
  });

  describe('getLatestBlockNumber', () => {
    it('should return the latest block number', async () => {
      const blockNumber = await monitor.getLatestBlockNumber();
      expect(blockNumber).toBe(1000000);
    });
  });

  describe('getBlockNumberForDate', () => {
    it('should estimate block number for a given date', async () => {
      const targetDate = new Date('2025-01-01T00:00:00Z');
      const blockNumber = await monitor.getBlockNumberForDate(targetDate);
      expect(typeof blockNumber).toBe('number');
      expect(blockNumber).toBeGreaterThanOrEqual(0);
    });
  });

  describe('checkForNewTransfers', () => {
    it('should return empty array when no new transfers', async () => {
      const transfers = await monitor.checkForNewTransfers();
      expect(transfers).toEqual([]);
    });
  });
});

