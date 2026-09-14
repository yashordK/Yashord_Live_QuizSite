export const PHASES = [
  "IDLE",
  "QUESTION_ONLY",
  "ACCEPTING_ANSWERS",
  "LOCKED",
  "REVEALED",
  "SOLUTION",
  "LEADERBOARD",
  "PODIUM",
] as const;

export type Phase = (typeof PHASES)[number];

export type SessionStatus = "lobby" | "live" | "ended";

export interface Option {
  key: string;
  text: string;
}

export interface SessionRow {
  id: string;
  code: string;
  title: string;
  status: SessionStatus;
  current_question_id: string | null;
  phase: Phase;
  phase_started_at: string;
  phase_duration_sec: number | null;
  join_cap: number;
  joining_locked: boolean;
  auto_advance: boolean;
  leaderboard_interval: number;
  leaderboard_shown_after: number;
  /** Places shown on the leaderboard; the qualifying cut for this event. */
  leaderboard_top: number;
  /** Optional prefixes offered on the join screen. Empty = free text. */
  roll_prefixes: string[];
  state_version: number;
  created_at: string;
  updated_at: string;
}

export interface QuestionRow {
  id: string;
  session_id: string;
  order_index: number;
  question_text: string;
  image_url: string | null;
  options: Option[];
  correct_option: string;
  solution_text: string | null;
  reading_time_sec: number;
  answer_time_sec: number;
  points: number;
  voided: boolean;
  skipped: boolean;
  created_at: string;
}

export interface ParticipantRow {
  id: string;
  session_id: string;
  roll_number: string;
  raw_roll_number: string | null;
  name: string;
  joined_at: string;
  last_seen_at: string;
  is_online: boolean;
  device_token: string | null;
  device_mismatches: number;
  flagged_duplicate: boolean;
}

export interface AnswerRow {
  id: string;
  question_id: string;
  participant_id: string;
  selected_option: string;
  is_correct: boolean;
  points_earned: number;
  server_elapsed_ms: number | null;
  answered_at: string;
}

export interface ScoreRow {
  participant_id: string;
  session_id: string;
  name: string;
  roll_number: string;
  is_online: boolean;
  last_seen_at: string;
  joined_at: string;
  flagged_duplicate: boolean;
  device_mismatches: number;
  total_score: number;
  correct_count: number;
  answered_count: number;
}

/**
 * What a question looks like to a STUDENT or the PROJECTOR.
 *
 * `correct_option` and `solution_text` are stripped until the phase makes
 * them public. This is done server-side in /api/state, not hidden in the
 * UI — a student with devtools open must not be able to read the answer
 * key out of a network response.
 */
export interface PublicQuestion {
  id: string;
  order_index: number;
  question_text: string;
  image_url: string | null;
  /** Withheld entirely during QUESTION_ONLY (question text only, no options). */
  options: Option[] | null;
  /** Present only from REVEALED onward. */
  correct_option: string | null;
  /** Present only during SOLUTION. */
  solution_text: string | null;
  answer_time_sec: number;
  reading_time_sec: number;
  points: number;
  voided: boolean;
}

export interface LeaderboardResponse {
  entries: LeaderboardEntry[];
  total_participants: number;
  /** The cut splits a tie — #N and #N+1 have the same score. */
  cutoff_tied: boolean;
  cutoff_score: number | null;
  me: { rank: number; total_score: number } | null;
}

export interface LeaderboardEntry {
  rank: number;
  name: string;
  roll_number: string;
  total_score: number;
}

/** The single payload every client renders from. */
export interface StatePayload {
  /** Server clock, so clients can correct for their own skew. */
  server_now: string;
  state_version: number;
  session: {
    code: string;
    title: string;
    status: SessionStatus;
    phase: Phase;
    phase_started_at: string;
    phase_duration_sec: number | null;
    joining_locked: boolean;
    join_cap: number;
    joined_count: number;
    /** Offered on the join screen; never used to reject a roll. */
    roll_prefixes: string[];
    /** Places the leaderboard shows = the qualifying cut. */
    leaderboard_top: number;
  };
  question: PublicQuestion | null;
  question_number: number | null;
  question_total: number | null;
  /** Present only when the request carries a valid participant cookie. */
  me?: {
    participant_id: string;
    name: string;
    roll_number: string;
    total_score: number;
    /** Their locked-in choice for the current question, if any. */
    my_answer: {
      selected_option: string;
      is_correct: boolean | null;
      points_earned: number | null;
    } | null;
  };
}
