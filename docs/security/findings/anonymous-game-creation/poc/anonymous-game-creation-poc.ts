const target = process.env.TARGET ?? "http://127.0.0.1:3000";
const count = Number.parseInt(process.env.COUNT ?? "25", 10);

if (!Number.isSafeInteger(count) || count < 1 || count > 500) {
  throw new Error("COUNT must be an integer from 1 to 500 for this bounded local probe.");
}

console.log(`[+] target: ${target}`);
console.log(`[+] creating ${count} games`);

const created: string[] = [];
for (let index = 0; index < count; index += 1) {
  const response = await fetch(`${target}/api/games`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      homeName: `PoC Home ${index}`,
      awayName: `PoC Away ${index}`,
    }),
  });

  if (response.status !== 201) {
    throw new Error(`creation ${index} failed with HTTP ${response.status}`);
  }

  const body = (await response.json()) as { gameId?: unknown };
  if (typeof body.gameId !== "string") {
    throw new Error(`creation ${index} did not return a gameId`);
  }
  created.push(body.gameId);
}

console.log(`[+] created ${created.length} games`);

const lobbyResponse = await fetch(`${target}/api/games`);
if (!lobbyResponse.ok) {
  throw new Error(`lobby read failed with HTTP ${lobbyResponse.status}`);
}

const lobby = (await lobbyResponse.json()) as { games?: unknown };
const games = Array.isArray(lobby.games) ? lobby.games : [];
if (games.length < created.length) {
  throw new Error(`expected at least ${created.length} games, saw ${games.length}`);
}

console.log(`[+] lobby now reports at least ${games.length} games`);
console.log("[+] local-only probe complete");
