// Team assignment. Pure functions with no Colyseus dependency.

import { MAX_TEAM_SIZE, TEAMS, type Team } from "../../../shared/protocol.js";

/** Anything with a team (the room's players). */
export interface HasTeam {
  team: string;
}

/** Number of players on each team among `players`. Unknown team strings are ignored. */
export function teamCounts(players: Iterable<HasTeam>): Record<Team, number> {
  const counts = Object.fromEntries(TEAMS.map((t) => [t, 0])) as Record<Team, number>;
  for (const p of players) {
    if ((TEAMS as readonly string[]).includes(p.team)) counts[p.team as Team]++;
  }
  return counts;
}

/**
 * The team for a new joiner, computed only from the players currently in the
 * room: the team with fewer players, ties going to the first in TEAMS
 * (`ghost`). Returns null if that team already has `maxTeamSize` players, so
 * the join must be refused. Clients never choose: join options are not an input.
 */
export function assignTeam(players: Iterable<HasTeam>, maxTeamSize: number = MAX_TEAM_SIZE): Team | null {
  const counts = teamCounts(players);
  let best: Team = TEAMS[0];
  for (const t of TEAMS) {
    if (counts[t] < counts[best]) best = t;
  }
  return counts[best] < maxTeamSize ? best : null;
}
