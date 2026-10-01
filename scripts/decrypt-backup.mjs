/**
 * Decrypt a backup file made by the nightly backup.
 *
 *   cd server
 *   node scripts/decrypt-backup.mjs <file.enc> [output-file]
 *
 * Works for the emailed spreadsheet (…xlsx.enc), the per-order receipt
 * (order-….xlsx.enc) and the database dump (nip-db-….jsonl.gz.enc). The output
 * defaults to the same name without ".enc".
 *
 * The password is BACKUP_PASSWORD — read from the environment (or server/.env)
 * if set there, otherwise asked for on the terminal without echoing it. A
 * wrong password, or a file damaged in transit, fails with an error; it never
 * produces a plausible-looking but wrong file (AES-256-GCM is authenticated).
 *
 * The decrypted file holds every customer's personal details. Open it on a
 * machine you trust, and delete it when you are done.
 */
import 'dotenv/config';
import fs from 'node:fs';
import readline from 'node:readline';
import { decryptFile } from '../src/utils/backupCrypto.js';

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.stdoutMuted = true;
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    // eslint-disable-next-line no-underscore-dangle
    rl._writeToOutput = (s) => {
      if (!rl.stdoutMuted || s.startsWith(question)) process.stdout.write(s);
    };
  });
}

const [input, outputArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!input) {
  console.error('Usage: node scripts/decrypt-backup.mjs <file.enc> [output-file]');
  process.exit(2);
}
if (!fs.existsSync(input)) {
  console.error(`No such file: ${input}`);
  process.exit(2);
}

const output = outputArg || (input.endsWith('.enc') ? input.slice(0, -4) : `${input}.decrypted`);
if (fs.existsSync(output) && !process.argv.includes('--force')) {
  console.error(`${output} already exists. Pass --force to overwrite it.`);
  process.exit(2);
}

const password = process.env.BACKUP_PASSWORD || await askHidden('Backup password: ');
if (!password) {
  console.error('No password given.');
  process.exit(2);
}

try {
  await decryptFile(input, output, password);
  console.log(`Decrypted to ${output}`);
  if (output.endsWith('.gz')) {
    console.log('This is a database dump. To load it into a database, see scripts/restore-backup.mjs');
    console.log('(restore-backup.mjs can also read the .enc file directly).');
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
