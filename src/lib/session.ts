import "server-only";

import { db } from "./supabase";
import { sessionConfig } from "./config";
// Question numbering is computed inside the get_state RPC (one round
// trip); the phase predicates stay here because the "when does the
// answer key become public" rule must live in exactly one place.
import {
  phaseShowsAnswerKey,
  phaseShowsOptions,
  phaseShowsSolution,
} from "./phases";
import type {
  SessionRow,
  QuestionRow,
  StatePayload,
  PublicQuestion,
  LeaderboardEntry,
  ScoreRow,
} from "./types";

export class NotFoundError extends Error {}

/** The one session this deployment drives, looked up by SESSION_CODE. */
export async function getSession(code = sessionConfig.code): Promise<SessionRow> {
  const { data, error } = await db()
    .from("sessions")
    .select("*")
    .eq("code", code.toUpperCase())
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    throw new NotFoundError(
      `No session with code "${code}". Run supabase/seed.sql, and check SESSION_CODE matches.`
    );
  }
  return data as SessionRow;
}

export async function getQuestions(sessionId: string): Promise<QuestionRow[]> {
  const { data, error } = await db()
    .from("questions")
    .select("*")
    .eq("session_id", sessionId)
    .order("order_index", { ascending: true });

  if (error) throw error;
  return (data ?? []) as QuestionRow[];
}

export async function countParticipants(sessionId: string): Promise<number> {
  const { count, error } = await db()
    .from("participants")
    .select("id", { count: "exact", head: true })
    .eq("session_id", sessionId);

  if (error) throw error;
  return count ?? 0;
}

/**
 * Strip a question down to what the current phase makes public.
 *
 * This is the server-side half of "no answer key visible". Doing it here
 * rather than in the UI is the point: a student with devtools open reads
 * the same JSON the React tree does, and during ACCEPTING_ANSWERS that
 * JSON simply does not contain `correct_option`.
 */
export function toPublicQuestion(
  q: QuestionRow,
  phase: SessionRow["phase"]
): PublicQuestion {
  return {
    id: q.id,
    order_index: q.order_index,
    question_text: q.question_text,
    image_url: q.image_url,
    options: phaseShowsOptions(phase) ? q.options : null,
    correct_option: phaseShowsAnswerKey(phase) ? q.correct_option : null,
    solution_text: phaseShowsSolution(phase) ? q.solution_text : null,
    answer_time_sec: q.answer_time_sec,
    reading_time_sec: q.reading_time_sec,
    points: q.points,
    voided: q.voided,
  };
}

export interface BuildStateOptions {
  /** When set, the payload includes a `me` block for this participant. */
  participantId?: string | null;
  /** Host requests see the answer key regardless of phase. */
  includeAnswerKey?: boolean;
}

interface RawState {
  not_found?: boolean;
  server_now: string;
  session: SessionRow;
  question: QuestionRow | null;
  joined_count: number;
  question_number: number | null;
  question_total: number | null;
  me: {
    participant_id: string;
    name: string;
    roll_number: string;
    total_score: number;
    my_answer: {
      selected_option: string;
      is_correct: boolean;
      points_earned: number;
    } | null;
  } | null;
}

/** One round trip; see supabase/migrations/0005_get_state.sql. */
export async function getRawState(
  participantId?: string | null
): Promise<RawState> {
  const { data, error } = await db().rpc("get_state", {
    p_code: sessionConfig.code,
    p_participant_id: participantId ?? null,
  });

  if (error) throw error;

  const raw = data as RawState;
  if (!raw || raw.not_found) {
    throw new NotFoundError(
      `No session with code "${sessionConfig.code}". Run supabase/seed.sql, and check SESSION_CODE matches.`
    );
  }
  return raw;
}

export async function buildStatePayload(
  opts: BuildStateOptions = {}
): Promise<StatePayload> {
  const raw = await getRawState(opts.participantId);
  const session = raw.session;
  const current = raw.question;

  let question: PublicQuestion | null = null;
  if (current) {
    // Phase-based stripping. The raw row carries the answer key; this is
    // the only place it is allowed to be removed, and it happens before
    // the payload is serialised to any client.
    question = toPublicQuestion(current, session.phase);

    if (opts.includeAnswerKey) {
      // Host control panel only — it needs to see the key before
      // revealing so a wrong entry can be caught. /present and /play
      // never pass this flag.
      question.correct_option = current.correct_option;
      question.solution_text = current.solution_text;
      question.options = current.options;
    }
  }

  const payload: StatePayload = {
    server_now: raw.server_now,
    state_version: session.state_version,
    session: {
      code: session.code,
      title: session.title,
      status: session.status,
      phase: session.phase,
      phase_started_at: session.phase_started_at,
      phase_duration_sec: session.phase_duration_sec,
      joining_locked: session.joining_locked,
      join_cap: session.join_cap,
      joined_count: raw.joined_count,
      roll_prefixes: Array.isArray(session.roll_prefixes)
        ? session.roll_prefixes
        : [],
    },
    question,
    question_number: raw.question_number,
    question_total: raw.question_total,
  };

  if (raw.me) {
    // Their locked-in choice is echoed back immediately so a rejoining
    // student sees what they already picked instead of an answerable
    // question. Correctness and points stay hidden until the reveal —
    // otherwise this response leaks the answer key to anyone who has
    // already answered.
    const revealed = phaseShowsAnswerKey(session.phase);
    payload.me = {
      participant_id: raw.me.participant_id,
      name: raw.me.name,
      roll_number: raw.me.roll_number,
      total_score: raw.me.total_score,
      my_answer: raw.me.my_answer
        ? {
            selected_option: raw.me.my_answer.selected_option,
            is_correct: revealed ? raw.me.my_answer.is_correct : null,
            points_earned: revealed ? raw.me.my_answer.points_earned : null,
          }
        : null,
    };
  }

  return payload;
}

/**
 * Score is ALWAYS derived. There is no stored score column to drift out
 * of sync, which is exactly why a rejoining student keeps their points
 * with no restoration logic at all.
 */
export async function getParticipantScore(
  participantId: string
): Promise<number> {
  const { data, error } = await db()
    .from("participant_scores")
    .select("total_score")
    .eq("participant_id", participantId)
    .maybeSingle();

  if (error) throw error;
  return data?.total_score ?? 0;
}

/**
 * Every answer row in the session, paged.
 *
 * PostgREST caps a response at 1000 rows by default. 200 students across
 * 25 questions is up to 5000 answers, so a single unpaged select would
 * silently return a truncated table and a wrong CSV export — the kind of
 * bug you'd only notice after the event. Hence the explicit paging.
 */
export async function getAllAnswers(sessionId: string): Promise<
  {
    participant_id: string;
    question_id: string;
    selected_option: string;
    is_correct: boolean;
    points_earned: number;
  }[]
> {
  const questions = await getQuestions(sessionId);
  const questionIds = questions.map((q) => q.id);
  if (questionIds.length === 0) return [];

  const PAGE = 1000;
  const out: Awaited<ReturnType<typeof getAllAnswers>> = [];

  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db()
      .from("answers")
      .select("participant_id, question_id, selected_option, is_correct, points_earned")
      .in("question_id", questionIds)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);

    if (error) throw error;
    const rows = data ?? [];
    out.push(...(rows as typeof out));
    if (rows.length < PAGE) break;
  }

  return out;
}

export async function getScoreRows(sessionId: string): Promise<ScoreRow[]> {
  const { data, error } = await db()
    .from("participant_scores")
    .select("*")
    .eq("session_id", sessionId);

  if (error) throw error;
  return (data ?? []) as ScoreRow[];
}

export interface LeaderboardResult {
  entries: LeaderboardEntry[];
  total_participants: number;
  me: { rank: number; total_score: number } | null;
}

/**
 * Leaderboard is PULL, not push — fetched when the phase becomes
 * REVEALED or LEADERBOARD. Subscribing 200 clients to live score updates
 * would be a message-count explosion for no benefit.
 *
 * Ties share a rank (standard competition ranking: 1, 2, 2, 4).
 */
export async function getLeaderboard(
  sessionId: string,
  opts: { limit?: number; participantId?: string | null } = {}
): Promise<LeaderboardResult> {
  // Ranked in SQL (0006_leaderboard.sql) rather than by pulling every
  // participant over the wire and sorting in JS. At a reveal, ~185
  // clients hit this within a second of each other, once per question —
  // it's the heaviest repeated operation in the whole quiz.
  const { data, error } = await db().rpc("get_leaderboard", {
    p_session_id: sessionId,
    p_limit: opts.limit ?? 10,
    p_participant_id: opts.participantId ?? null,
  });

  if (error) throw error;

  const result = data as {
    entries: LeaderboardEntry[];
    total_participants: number;
    me: { rank: number; total_score: number } | null;
  };

  return {
    entries: result?.entries ?? [],
    total_participants: result?.total_participants ?? 0,
    me: result?.me ?? null,
  };
}

/**
 * Apply a computed state transition atomically and return the new
 * version. phase_started_at is set from the database clock inside the
 * function, so every client in the room counts down against one origin.
 */
export async function writeSessionState(
  sessionId: string,
  next: {
    phase: string;
    status: string;
    currentQuestionId: string | null;
    durationSec: number | null;
    leaderboardShownAfter: number;
  }
): Promise<{ state_version: number; phase_started_at: string }> {
  const { data, error } = await db().rpc("set_session_state", {
    p_session_id: sessionId,
    p_phase: next.phase,
    p_status: next.status,
    p_current_question_id: next.currentQuestionId,
    p_duration_sec: next.durationSec,
    p_leaderboard_shown_after: next.leaderboardShownAfter,
  });

  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row as { state_version: number; phase_started_at: string };
}

/** Answer counts per option for the current question (host view only). */
export async function getAnswerDistribution(
  questionId: string
): Promise<Record<string, number>> {
  const { data, error } = await db().rpc("answer_distribution", {
    p_question_id: questionId,
  });

  if (error) throw error;

  const out: Record<string, number> = {};
  for (const row of (data ?? []) as { selected_option: string; n: number }[]) {
    out[row.selected_option] = Number(row.n);
  }
  return out;
}
