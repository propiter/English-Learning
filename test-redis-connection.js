import { createClient } from 'redis';
import dotenv from 'dotenv';

dotenv.config();

async function testRedisConnection() {
  const client = createClient({
    url: process.env.REDIS_URL,
    socket: {
      connectTimeout: 5000,
      reconnectStrategy: (retries) => {
        console.log(`Retry attempt ${retries}`);
        return Math.min(retries * 100, 5000);
      }
    }
  });

  client.on('error', (err) => {
    console.error('Redis Client Error:', err);
  });

  client.on('connect', () => {
    console.log('Redis: Connecting...');
  });

  client.on('ready', () => {
    console.log('Redis: Connected and ready');
  });

  try {
    await client.connect();
    console.log('Successfully connected to Redis');
    await client.set('test', 'Hello Redis');
    const value = await client.get('test');
    console.log('Test value from Redis:', value);
  } catch (err) {
    console.error('Failed to connect to Redis:', err);
  } finally {
    await client.quit();
  }
}

testRedisConnection();
