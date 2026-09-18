// The Stats tab (player drilldown with hit-rate charts) wasn't part of
// the original build — the brief was to keep the slip GENERATOR as the
// core, not a browsable prop board. Design included a Stats tab anyway
// with mock data, so this stub keeps the tab from crashing (empty state
// instead of an error) rather than silently leaving fake data live.
//
// If you want this tab real: it needs its own design decision — which
// players get shown (everyone in the current slip? a manual watchlist?)
// — before it's worth wiring to SportsGameOdds/ESPN.

exports.handler = async () => {
  return { statusCode: 200, body: JSON.stringify({ players: [] }) };
};
