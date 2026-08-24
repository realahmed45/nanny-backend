/**
 * Payment gateway abstraction.
 *
 * The mock provider approves every charge and refund immediately, which is what
 * the chatbot script assumes ("Processing payment... Payment successful").
 * To go live, implement the same three methods against Stripe/PayPal/etc. and
 * swap the export — no flow code changes.
 */
import { nextSequence } from '../models/Counter.js';

export const mockGateway = {
  name: 'mock',

  async charge({ amount, currency = 'USD', method = 'credit_card', metadata = {} }) {
    const ref = `CH-${await nextSequence('payment_ref', 100000)}`;
    return {
      success: true,
      providerRef: ref,
      amount,
      currency,
      method,
      metadata,
      processedAt: new Date(),
    };
  },

  async refund({ amount, currency = 'USD', originalRef, metadata = {} }) {
    const ref = `RF-${await nextSequence('payment_ref', 100000)}`;
    return {
      success: true,
      providerRef: ref,
      amount,
      currency,
      originalRef,
      metadata,
      processedAt: new Date(),
    };
  },

  async payout({ amount, currency = 'USD', metadata = {} }) {
    const ref = `PO-${await nextSequence('payment_ref', 100000)}`;
    return { success: true, providerRef: ref, amount, currency, metadata, processedAt: new Date() };
  },
};

export const gateway = mockGateway;
export default gateway;
