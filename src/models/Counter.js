import mongoose from 'mongoose';

/** Atomic sequence generator for booking/ticket/payment reference numbers. */
const CounterSchema = new mongoose.Schema({
  _id: String,
  seq: { type: Number, default: 0 },
});

const Counter = mongoose.model('Counter', CounterSchema);

export async function nextSequence(name, start = 1000) {
  const doc = await Counter.findByIdAndUpdate(
    name,
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return start + doc.seq;
}

export default Counter;
