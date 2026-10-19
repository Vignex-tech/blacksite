// Mocha setup (loaded with -r before any test file imports the room): the
// existing tests expect a room that is live from creation, so the server's own
// startup preset is `open`. Round tests assign room.roundSettings directly.
process.env.BLACKSITE_ROUND_PRESET = "open";
