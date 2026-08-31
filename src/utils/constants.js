// Catalogs + enums derived directly from the chatbot script spec.

export const LANGUAGES = ['English', 'Arabic', 'French', 'Spanish'];
export const SKILLS = ['Cooking', 'Cleaning', 'Newborn Care', 'Tutoring'];
export const SUBJECTS = ['English', 'Math', 'Music', 'Art', 'All Homework'];
export const WEEKDAYS = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

// Menu option -> hours. Spec offers 1..8, then 12, then 24.
export const DURATION_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 12, 24];

export const LANGUAGE_PROFICIENCY = {
  1: 'Basic', 2: 'Elementary', 3: 'Good', 4: 'Very Good', 5: 'Fluent',
};
export const SKILL_PROFICIENCY = {
  1: 'Beginner', 2: 'Basic', 3: 'Good', 4: 'Very Good', 5: 'Expert',
};

export const CPR_REQUIREMENT = {
  REQUIRED: 'required',
  NOT_REQUIRED: 'not_required',
  EITHER: 'either',
};

export const USER_ROLE = { FAMILY: 'family', NANNY: 'nanny' };

export const NANNY_STATUS = {
  PENDING_VERIFICATION: 'pending_verification',
  VERIFIED: 'verified',
  REJECTED: 'rejected',
  SUSPENDED: 'suspended',
};

// Booking lifecycle. Sub-states track the detailed spec table.
export const BOOKING_STATUS = {
  DRAFT: 'draft',
  PENDING_PAYMENT: 'pending_payment',
  UPCOMING: 'upcoming',
  PENDING_ADDITIONAL_PAYMENT: 'pending_additional_payment',
  ONGOING: 'ongoing',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
};

export const BOOKING_SUBSTATUS = {
  AWAITING_NANNY_CONFIRMATION: 'awaiting_nanny_confirmation',
  NANNY_CONFIRMED: 'nanny_confirmed',
  NANNY_CANCELLED_AWAITING_REPLACEMENT: 'nanny_cancelled_awaiting_replacement',
  AWAITING_CHANGE_CONFIRMATION: 'awaiting_change_confirmation',
  AWAITING_ARRIVAL: 'awaiting_arrival',
  ARRIVAL_CONFIRMED: 'arrival_confirmed',
  AWAITING_END_OF_SERVICE: 'awaiting_end_of_service',
  TODAYS_SERVICE_COMPLETED: 'todays_service_completed',
};

export const SERVICE_DAY_STATUS = {
  SCHEDULED: 'scheduled',
  AWAITING_ARRIVAL: 'awaiting_arrival',
  ARRIVAL_CONFIRMED: 'arrival_confirmed',
  AWAITING_END_OF_SERVICE: 'awaiting_end_of_service',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
};

export const PAYMENT_STATUS = {
  COMPLETED: 'payment_completed',
  IN_PROCESS: 'payment_in_process',
  REFUND_IN_PROCESS: 'refund_in_process',
  REFUNDED: 'refunded',
  FAILED: 'payment_failed',
};

export const PAYOUT_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FINAL_DONE: 'final_payment_done',
  FAILED: 'failed',
};

export const CANCELLED_BY = { FAMILY: 'family', NANNY: 'nanny', ADMIN: 'admin', SYSTEM: 'system' };

export const TICKET_STATUS = { OPEN: 'open', IN_PROGRESS: 'in_progress', RESOLVED: 'resolved', CLOSED: 'closed' };

export const TICKET_CATEGORY = {
  BOOKING: 'booking_issue',
  PAYMENT: 'payment_refund',
  NANNY: 'nanny_issue',
  FAMILY: 'family_issue',
  ACCOUNT: 'account_issue',
  TECHNICAL: 'technical_problem',
  AGENT: 'agent_callback',
  OTHER: 'other',
};

// Global commands available at (almost) any point in the conversation.
export const COMMANDS = {
  SKIP: 'skip',
  MAIN_MENU: '0',
  NEXT: 'next',
  BYE: 'bye',
  CANCEL: 'cancel',
  BACK: 'back',
  NONE: 'none',
};

export default {
  LANGUAGES, SKILLS, SUBJECTS, WEEKDAYS, DURATION_OPTIONS,
  LANGUAGE_PROFICIENCY, SKILL_PROFICIENCY, CPR_REQUIREMENT,
  USER_ROLE, NANNY_STATUS, BOOKING_STATUS, BOOKING_SUBSTATUS,
  SERVICE_DAY_STATUS, PAYMENT_STATUS, PAYOUT_STATUS, CANCELLED_BY,
  TICKET_STATUS, TICKET_CATEGORY, COMMANDS,
};
