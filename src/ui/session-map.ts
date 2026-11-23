import type { Session } from '../net/session-types';

/** Lobby seat -> game player id. Falls back to identity for pre-migration local sessions. */
export function seatToPlayer(session: Session, seat: number): number | null {
  const fn = session.seatToPlayer;
  if (typeof fn !== 'function') return seat;
  return session.seatToPlayer(seat);
}

/** Game player id -> lobby seat. Falls back to identity for pre-migration local sessions. */
export function playerToSeat(session: Session, playerId: number): number | null {
  const fn = session.playerToSeat;
  if (typeof fn !== 'function') return playerId;
  return session.playerToSeat(playerId);
}

export function myPlayerIds(session: Session): number[] {
  const ids: number[] = [];
  for (const seat of session.mySeats()) {
    const playerId = seatToPlayer(session, seat);
    if (playerId !== null && !ids.includes(playerId)) ids.push(playerId);
  }
  return ids;
}
