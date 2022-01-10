import { promisify } from 'util';

const timeoutAsync = promisify((ms: number, cb: (err: any) => void) => setTimeout(cb, ms))

export async function retryWithBackoff<T>(func: (...args: any[]) => T, tries = 10, constantWait?: number): Promise<T> {
  let lastErr: Error = new Error();
  for (let i=0; i < tries; i++) {
    try {
      const result = await func();
      return result;
    } catch (err) {
      lastErr = err;
      const timeout = constantWait ? constantWait : (2**i) * 100
      console.error(`Error occurred, retrying in ${timeout}ms`)
      console.error(err);
      await timeoutAsync(timeout);
    }
  }
  throw lastErr;
}
