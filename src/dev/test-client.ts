import { Pool, PoolClient } from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';

const timeoutAsync = promisify((ms: number, cb: (err: any) => void) => setTimeout(cb, ms))


const host = process.argv[2];
const certDir = process.argv[3] || "certs"

async function main() {
  const pool = new Pool({
    // host,
    // port: 26257,
    // ssl: {
    //   ca: readFileSync(join(certDir, "ca.crt")),
    //   key: readFileSync(join(certDir, "client.root.key")),
    //   cert: readFileSync(join(certDir, "client.root.crt"))
    // },
    // user: 'root',
    // database: 'defaultdb',
    ssl: {
     rejectUnauthorized: false,
    },
    port: 26256,
    password: 'cN\\o$w2a!>)Yt|zG4}f;',
    user: 'lambda',
    database: 'nrfcloud',
    host,
    max: 3,
    min: 3,
    // @ts-ignore
    // verify: (client: PoolClient, callback: (err?: Error) => void) => {
    //   client.query('select arstoaiernst;', callback)
    // },
    keepAlive: true,
    keepAliveInitialDelayMillis: 0
  })

  pool.on('error', err => console.error("Error event"))

  while (true) {
    // console.log("checking connected nodes")
    const promises = [];
    const clients: any[] = [];
    let count = 3;
    while (count--) {
      // const client = await pool.connect();
      promises.push(pool.query(`show node_id;`));
    }
    const result = await Promise.allSettled(promises)
    // console.log(`Idle: ${pool.idleCount} Waiting: ${pool.waitingCount} Total: ${pool.totalCount}`)
    result.forEach(result => {
      if (result.status === "fulfilled") {
        // console.log('Connected to Node: ' + JSON.stringify(result.value.rows[0]))
      } else {
        console.log(`Idle: ${pool.idleCount} Waiting: ${pool.waitingCount} Total: ${pool.totalCount}`)
        console.error("Failed to run query")
        console.error(result.reason)
      }
    })
    clients.forEach(client => client.release())
    await timeoutAsync(100)
  }
}

async function retryOnShutdown<T>(handler: () => Promise<T>, tries = 3): Promise<T> {
  while (tries--) {
    try {
      return await handler();
    } catch (err) {
      console.log(err.message)
      console.log(err.name)
      if (err.code !== "57P01" || tries == 0) {
        throw err
      }
    }
  }
  throw new Error("exhausted retries")
}

main()
