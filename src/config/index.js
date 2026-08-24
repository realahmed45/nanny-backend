import dotenv from 'dotenv';
dotenv.config();

const int = (v, d) => (v === undefined || v === '' ? d : parseInt(v, 10));

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 4000),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://localhost:4000',

  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/mynanny',

  jwtSecret: process.env.JWT_SECRET || 'dev-secret',
  admin: {
    email: process.env.ADMIN_EMAIL || 'admin@mynanny.com',
    password: process.env.ADMIN_PASSWORD || 'admin123',
  },

  ultramsg: {
    instanceId: process.env.ULTRAMSG_INSTANCE_ID || '',
    token: process.env.ULTRAMSG_TOKEN || '',
    baseUrl: process.env.ULTRAMSG_BASE_URL || 'https://api.ultramsg.com',
    webhookToken: process.env.ULTRAMSG_WEBHOOK_TOKEN || '',
  },

  currency: process.env.CURRENCY || 'USD',
  transportFee: {
    min: int(process.env.TRANSPORT_FEE_MIN, 50000),
    max: int(process.env.TRANSPORT_FEE_MAX, 100000),
  },

  // Response windows (spec: 1h new booking, 2h existing booking change)
  newBookingResponseMinutes: int(process.env.NEW_BOOKING_RESPONSE_MINUTES, 60),
  changeBookingResponseMinutes: int(process.env.CHANGE_BOOKING_RESPONSE_MINUTES, 120),

  reschedulePenaltyPercent: int(process.env.RESCHEDULE_PENALTY_PERCENT, 5),
  freeRescheduleLimit: int(process.env.FREE_RESCHEDULE_LIMIT, 3),
  liveLocationWindowHours: int(process.env.LIVE_LOCATION_WINDOW_HOURS, 2),
};

export default config;
