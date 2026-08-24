import mongoose from 'mongoose';
import config from './index.js';

mongoose.set('strictQuery', true);

export async function connectDB(uri = config.mongoUri) {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  console.log(`[db] connected to ${redact(uri)}`);
  return mongoose.connection;
}

export async function disconnectDB() {
  await mongoose.disconnect();
}

/** Hide credentials when logging a connection string. */
function redact(uri) {
  return String(uri).replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@');
}

export default { connectDB, disconnectDB };
