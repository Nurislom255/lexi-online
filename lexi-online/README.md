# Lexi Online

A multiplayer word-card duel for CS students, played in the browser. 2–4 players sit at a
table, throw vocabulary cards at each other, and score by naming words from their definitions.
It uses the same 852 words from 15 courses as the Lexi console game.

The console game (`lexi-console`) is the graded C++ project. Lexi Online is a separate extra:
it shows how the project could be scaled up.

## How to play

1. One player opens a table and shares the 4-letter code (or the invite link). Up to 3 friends join.
2. The host picks which course libraries go in the deck and how many points win (8, 10 or 15).
3. Everyone holds 5 cards: **word cards** (always at least 2) and **power cards**.
4. On your turn, pick a word card, optionally add a power card, tap an opponent, and throw.
   You can see the word and its definition, so throw the one you think they won't know.
5. The defender sees only the definition and picks the word from 4 options before time runs out.

| Outcome | Points |
|---|---|
| Defender is right | Defender +2, or +3 if they answer in the first third of the time |
| Defender is wrong or too slow | Thrower +2 |

| Power card | Kind | Effect |
|---|---|---|
| Blitz | Attack | Only 6 seconds to answer instead of 15 |
| Double | Attack | Every point in this duel counts twice |
| Crowd | Attack | 6 answers instead of 4 |
| Steal | Attack | If they miss, you also take 1 of their points |
| Peek | Defence | Play it while answering to cross out 2 wrong answers |

You have 40 seconds to throw; if time runs out, a random word card is thrown for you.
First to the target score wins. All of these numbers are constants at the top of `server.js`.

## Run it on your own computer

You only need [Node.js](https://nodejs.org) 18 or newer. There are no packages to install.

```bash
cd lexi-online
node server.js
```

Open <http://localhost:3000>. To test multiplayer alone, open a second browser window
(or a private window) and join with the table code.

Friends on the same Wi-Fi can join at `http://<your-computer's-IP>:3000`. On Windows, find
your IP with `ipconfig`. Windows may ask to allow Node through the firewall.

## Put it online with AWS EC2

These steps use Amazon Linux 2023 and the AWS console in a browser.

### 1. Launch the server

1. EC2 console → **Launch instance**.
2. Name: `lexi-online`. Image: **Amazon Linux 2023**.
3. Instance type: **t3.micro**, which is free-tier eligible on both old and new accounts.
4. Key pair: create one and keep the `.pem` file safe. You only need it if you use SSH from your laptop.
5. Network settings → **Edit** → security group rules:
   - SSH, port 22, source **My IP**
   - HTTP, port 80, source **Anywhere (0.0.0.0/0)**, so players can reach the game
6. Storage: the default 8 GB is plenty. Then **Launch instance**.

### 2. Connect and install Node.js

Open the instance → **Connect** → **EC2 Instance Connect** → **Connect**. This opens a terminal in
your browser. Then run:

```bash
sudo dnf install -y nodejs22
node --version
```

Amazon Linux 2023 packages Node.js 20, 22 and 24 as `nodejs20`, `nodejs22` and `nodejs24`.
Any of them works.

### 3. Upload the game

Either push the folder to GitHub and run this on the server:

```bash
git clone https://github.com/<you>/lexi-online.git
```

or copy it from your laptop. Run this on your laptop, in the folder that contains `lexi-online`:

```bash
scp -i your-key.pem -r lexi-online ec2-user@<PUBLIC-IP>:~
```

### 4. Try it

```bash
cd ~/lexi-online
sudo PORT=80 node server.js
```

Open `http://<PUBLIC-IP>` (http, not https) from your phone. If it loads, press `Ctrl+C` and
go on to step 5.

### 5. Keep it running

`lexi.service` makes Linux start the game automatically, restart it if it crashes, and start it
again after a reboot:

```bash
sudo cp ~/lexi-online/lexi.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lexi
sudo systemctl status lexi          # should say "active (running)"
journalctl -u lexi -f               # live log; Ctrl+C to stop watching
```

After you change the code, run `sudo systemctl restart lexi`.

### 6. Cost and safety checklist

- **Set a budget alert first:** Billing → Budgets → create a zero-spend or $1 budget.
- **Stop the instance when you're not playing:** Instance state → Stop. A stopped instance
  doesn't use compute hours, but the 8 GB disk is still stored.
- **The public IP changes** every time you stop and start the instance, so share the new
  address. An Elastic IP keeps it fixed, but it is billed whenever it isn't attached to a
  running instance.
- **Public IPv4 addresses cost money:** AWS charges $0.005 per hour for each one, about $3.60
  a month. On the legacy free tier, 750 hours a month on EC2 are free for the first 12 months.
  On the new Free plan, the charge comes out of your credits.
- **New Free plan accounts are closed** when the credits run out or after 6 months, whichever
  comes first.

## How it works

```
Browser (public/app.js)                          Server (server.js)
  POST /api/create, /api/join   --------->  makes a table / a seat, returns a secret token
  GET  /api/events  <=== live stream =====  Server-Sent Events: the new table state,
                                            pushed to every player after each change
  POST /api/action  --------->              throw, answer, peek, settings, start
                                            checks the rules, updates the state, pushes it
```

- **The server owns the game.** Browsers only send moves. The server checks every move
  (is it your turn, is that card really in your hand?) and decides the points. Nobody can
  cheat by editing the page.
- **Each player sees only what they should.** `viewFor()` builds a separate view for each
  player: your own hand, but only the number of cards other players hold. The defender never
  receives the right answer until the reveal.
- **Timers run on the server** (`setTimer`), so a slow phone can't get extra time.
- **Reconnecting:** your seat's secret token is saved in the browser, so refreshing the page
  or losing Wi-Fi for a moment puts you back in your seat.
- **Player names can't inject HTML:** all text is added with `textContent`. We tested this with
  a player called `<b>Timur</b>`, and the name shows up as plain text.
- **Everything is kept in memory.** Restarting the server ends every game. That's fine for a
  game of a few minutes, and a database would be the next step.

| File | What's in it |
|---|---|
| `server.js` | Rules, rooms, timers, scoring, the HTTP server and live updates |
| `public/app.js` | Draws the home, lobby, table and end screens from the server's state |
| `public/style.css` | The card table: baize, index-card word cards, navy-and-brass power cards |
| `public/index.html` | The empty page that loads the two files above |
| `data/subjects.json` | The 15 course libraries, the same file as in the console game |
| `lexi.service` | Keeps the game running on EC2 |

## Credits

Code drafted with help from Claude (Anthropic AI); reviewed and modified by the team.
The word definitions and examples were written for this project with AI help and checked by the team.
