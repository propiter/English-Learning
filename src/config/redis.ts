import { createClient, RedisClientType } from 'redis';
import { logger } from '../utils/logger.js';
import env from './environment.js';

/**
 * Redis client instance
 */
class RedisManager {
  private client: RedisClientType;
  private isConnected: boolean = false;

  constructor() {
    this.client = createClient({
      url: env.REDIS_URL,
      socket: {
        connectTimeout: 10000,
        reconnectStrategy: (retries) => {
          if (retries > 10) {
            logger.error('Redis: Maximum reconnection attempts reached');
            return false;
          }
          const delay = Math.min(retries * 100, 3000);
          logger.warn(`Redis: Reconnecting in ${delay}ms (attempt ${retries})`);
          return delay;
        }
      },
      lazyConnect: true
    });

    this.setupEventHandlers();
  }

  /**
   * Setup Redis event handlers
   */
  private setupEventHandlers(): void {
    this.client.on('connect', () => {
      logger.info('Redis: Connecting...');
    });

    this.client.on('ready', () => {
      this.isConnected = true;
      logger.info('Redis: Connected and ready');
    });

    this.client.on('error', (err) => {
      this.isConnected = false;
      logger.error('Redis: Connection error', { error: err.message });
    });

    this.client.on('end', () => {
      this.isConnected = false;
      logger.warn('Redis: Connection ended');
    });

    this.client.on('reconnecting', () => {
      logger.info('Redis: Reconnecting...');
    });
  }

  /**
   * Connect to Redis
   */
  async connect(): Promise<void> {
    try {
      if (!this.isConnected) {
        await this.client.connect();
      }
    } catch (error) {
      logger.error('Redis: Failed to connect', { error });
      throw error;
    }
  }

  /**
   * Disconnect from Redis
   */
  async disconnect(): Promise<void> {
    try {
      if (this.isConnected) {
        await this.client.disconnect();
        this.isConnected = false;
        logger.info('Redis: Disconnected');
      }
    } catch (error) {
      logger.error('Redis: Failed to disconnect', { error });
    }
  }

  /**
   * Get Redis client
   */
  getClient(): RedisClientType {
    return this.client;
  }

  /**
   * Check if Redis is connected
   */
  isReady(): boolean {
    return this.isConnected;
  }

  /**
   * Set key with expiration
   */
  async setex(key: string, seconds: number, value: string): Promise<void> {
    try {
      await this.client.setEx(key, seconds, value);
    } catch (error) {
      logger.error('Redis: Failed to set key', { key, error });
      throw error;
    }
  }

  /**
   * Get key value
   */
  async get(key: string): Promise<string | null> {
    try {
      return await this.client.get(key);
    } catch (error) {
      logger.error('Redis: Failed to get key', { key, error });
      throw error;
    }
  }

  /**
   * Delete key
   */
  async del(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch (error) {
      logger.error('Redis: Failed to delete key', { key, error });
      throw error;
    }
  }

  /**
   * Set hash field
   */
  async hset(key: string, field: string, value: string): Promise<void> {
    try {
      await this.client.hSet(key, field, value);
    } catch (error) {
      logger.error('Redis: Failed to set hash field', { key, field, error });
      throw error;
    }
  }

  /**
   * Get hash field
   */
  async hget(key: string, field: string): Promise<string | undefined> {
    try {
      return await this.client.hGet(key, field);
    } catch (error) {
      logger.error('Redis: Failed to get hash field', { key, field, error });
      throw error;
    }
  }

  /**
   * Get all hash fields
   */
  async hgetall(key: string): Promise<Record<string, string>> {
    try {
      return await this.client.hGetAll(key);
    } catch (error) {
      logger.error('Redis: Failed to get all hash fields', { key, error });
      throw error;
    }
  }

  /**
   * Check if key exists
   */
  async exists(key: string): Promise<boolean> {
    try {
      const result = await this.client.exists(key);
      return result === 1;
    } catch (error) {
      logger.error('Redis: Failed to check key existence', { key, error });
      throw error;
    }
  }

  /**
   * Set key with JSON value
   */
  async setJSON(key: string, value: any, seconds?: number): Promise<void> {
    const jsonValue = JSON.stringify(value);
    if (seconds) {
      await this.setex(key, seconds, jsonValue);
    } else {
      await this.client.set(key, jsonValue);
    }
  }

  /**
   * Get key with JSON value
   */
  async getJSON<T>(key: string): Promise<T | null> {
    const value = await this.get(key);
    if (!value) return null;
    
    try {
      return JSON.parse(value) as T;
    } catch (error) {
      logger.error('Redis: Failed to parse JSON value', { key, error });
      return null;
    }
  }
}

// Create and export Redis manager instance
const redisManager = new RedisManager();

export default redisManager;
export { RedisManager };