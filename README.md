# QuizzlyPop 🎉

Turn inside jokes & photos into a live multiplayer trivia show in 3 minutes.

The host answers 10 prompts about the guest of honor and uploads a few photos. Claude writes the quiz (questions plus funny wrong answers), and the host reviews and edits it. Then the TV shows a QR code, guests join on their phones, and everyone plays.

## Run it

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start
# open http://localhost:3000
```

Without `ANTHROPIC_API_KEY` the app still works: it uses template questions and shows the host a banner.

| Env var | Default | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | (none) | Turns on AI question writing |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Model used for generation |
| `PORT` | `3000` | |
| `PUBLIC_URL` | from request | Base URL encoded in the QR code (set this behind a proxy) |
| `ADMIN_KEY` | `letmein` | **Change this.** Protects `/stats` |
| `DATA_DIR` | `./data` | Where `events.jsonl` (analytics) is written |

## Pages

- `/`: landing page, setup wizard, and question review
- `/host?code=XXXXX`: TV screen (lobby + QR, questions, leaderboard, podium)
- `/play?code=XXXXX`: phone controller
- `/stats?key=ADMIN_KEY`: founder funnel (setup → created → started → finished, paywall clicks, end-screen CTA clicks)

## How it works

- **One Node process.** Express + Socket.io, with all game state kept in memory. Games expire after 12h. There's no database or accounts.
- **Reconnects.** Each phone stores its player id in `localStorage`. A guest who reloads or wakes their phone rejoins with their score intact.
- **Scoring.** A correct answer earns 500–1000 points depending on speed, plus up to +300 for a streak.
- **Fake-door paywall.** When the 9th player joins, the host sees "Party Pass $15". Clicking it logs `paywall_click` and unlocks the game for free. Nobody is ever blocked.
- **Viral loop.** The end screen on every phone links to `/go?src=player_end`, which is tracked as `cta_click`.

## Deploy (Railway / Render)

It's a plain Node web service: build `npm install`, start `npm start`. It needs WebSocket support, which both platforms provide. Run **one instance**, because state lives in memory. Set `PUBLIC_URL` and `ADMIN_KEY`.

## Known prototype limits

- A server restart ends any live game.
- It doesn't scale past one instance. Moving state to Redis is the fix later.
- Photos live in RAM: 6 per game, about 150KB each after resizing in the browser.
