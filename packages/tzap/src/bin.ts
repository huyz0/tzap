#!/usr/bin/env node
import { main } from './cli.js';

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`tzap: ${(e as Error).stack ?? String(e)}\n`);
    process.exitCode = 3;
  },
);
