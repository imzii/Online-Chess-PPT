const express = require('express');
const mysql = require('mysql2');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const { Chess } = require('chess.js');

const app = express();

dotenv.config();

const connection = mysql.createConnection(process.env.DATABASE_URL);
const port = process.env.PORT || 3000;
const saltRounds = 10;

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// 미들웨어를 사용하여 기본적으로 UTF-8로 JSON을 전송하도록 설정
app.use((req, res, next) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    next();
});

let onlineUsers = [];
let queue = [];
const games = {}; // 게임 정보를 저장하는 객체

app.post('/signup', (req, res) => {
    const { email, password, name } = req.body;
    bcrypt.genSalt(saltRounds, function (err, salt) {
        if (err) throw err;
        bcrypt.hash(password, salt, function (err, hash) {
            if (err) throw err;
            const sql = 'INSERT INTO users (email, password_hash, salt, name) VALUES (?, ?, ?, ?)';
            connection.query(sql, [email, hash, salt, name], function (err, results) {
                if (err) throw err;
                console.log('유저 정보 저장 성공');
                return res.send();
            });
        });
    });
});

app.post('/signin', (req, res) => {
    const { email, password } = req.body;
    const sql = 'SELECT * FROM users WHERE email = ?';
    connection.query(sql, [email], function (err, results) {
        if (err) throw err;
        if (results.length > 0) {
            const user = results[0];
            // bcrypt의 compare 함수를 사용하여 사용자가 제공한 비밀번호와 데이터베이스에 저장된 해시를 비교한다.
            bcrypt.compare(password, user.password_hash, function (err, isMatch) {
                if (err) throw err;
                if (isMatch) {
                    // 로그인 성공
                    onlineUsers.push({ email: user.email, elo: user.elo, name: user.name });
                    console.log(`${email}님 환영합니다!`)
                    return res.json({ email: user.email, elo: user.elo, name: user.name });
                } else {
                    return res.send('비밀번호 불일치');
                }
            });
        } else {
            return res.send('이메일이 존재하지 않음');
        }
    });
});

app.post('/signout', (req, res) => {
    const email = req.body.email;
    let index = onlineUsers.findIndex(user => user.email === email);
    if (index !== -1) {
        onlineUsers.splice(index, 1);
        return res.json({});
    }
    else {
        return res.send('로그아웃 실패');
    }
});

// Calculate expected outcome
function expectedOutcome(ra, rb) {
    return 1 / (1 + Math.pow(10, (rb - ra) / 400));
}

// Update Elo ratings
function updateElo(ra, rb, sa, K) {
    let ea = expectedOutcome(ra, rb);
    let eb = expectedOutcome(rb, ra);
    // Calculate the new Elo ratings
    let rpa = ra + K * (sa - ea);
    let rpb = rb + K * ((1 - sa) - eb);
    return [rpa, rpb];
}

// ELO rating system algorithm 
function matchPlayers() {
    queue.sort((a, b) => b.waitingTime - a.waitingTime);
    const player1 = queue.shift();

    const timeThreshold = 5 * 60 * 1000;
    const eloConsideration = player1.waitingTime > timeThreshold ? 0.5 : 1;
    const maxEloDifference = 200;

    let closestEloDiff = Infinity;
    let player2Index = -1;

    for (let i = 0; i < queue.length; i++) {
        const eloDiff = Math.abs(player1.elo - queue[i].elo);
        if (eloDiff < closestEloDiff && eloDiff <= maxEloDifference * eloConsideration) {
            closestEloDiff = eloDiff;
            player2Index = i;
        }
    }

    if (player2Index === -1) {
        queue.push(player1);
        return null;
    }

    const player2 = queue.splice(player2Index, 1)[0];
    return [player1, player2];
}

setInterval(() => {
    if (queue.length > 1) {
        for (let player of queue) {
            player.waitingTime = Date.now() - player.joinTime;
        }
        const matchedPlayers = matchPlayers();
        if (matchedPlayers) {
            let player1 = matchedPlayers[0];
            let player2 = matchedPlayers[1];
            let current_player = player1.elo > player2.elo ? player2 : player1;
            const chess = new Chess();
            const fen = chess.fen();
            const sql = 'INSERT INTO games (player1_email, player2_email, current_turn, fen) VALUES (?, ?, ?, ?);';
            connection.query(sql, [player1.email, player2.email, current_player.email, fen], function (err, results) {
                if (err) throw err;
                const game_id = results.insertId;
                player1.res.json({
                    status: 'matched',
                    self: { email: player1.email, elo: player1.elo, name: player1.name },
                    opponent: { email: player2.email, elo: player2.elo, name: player2.name },
                    game_id: game_id,
                    is_first_player: (player1.elo < player2.elo)
                });
                player2.res.json({
                    status: 'matched',
                    self: { email: player2.email, elo: player2.elo, name: player2.name },
                    opponent: { email: player1.email, elo: player1.elo, name: player1.name},
                    game_id: game_id,
                    is_first_player: (player2.elo < player1.elo)
                });
                games[game_id] = {
                    players: [
                        {
                            email: player1.email,
                            res: null
                        },
                        {
                            email: player2.email,
                            res: null
                        }
                    ]
                };
                console.log({
                    self: { email: player2.email, elo: player2.elo, name: player2.name },
                    opponent: { email: player1.email, elo: player1.elo, name: player1.name },
                    game_id: game_id
                });
                console.log(`${game_id}번 게임 시작!`);
            });
        }
    }
}, 1000);

app.post('/matchmaking', (req, res) => {
    const player = req.body;
    console.log(player);
    player.joinTime = Date.now();
    player.res = res;
    
    let playerExists;
    for (const existingPlayer of queue) {
        if (existingPlayer.email === player.email) {
            playerExists = true;
        }
    }
    
    if (!playerExists) {
        queue.push(player);
    }

    setTimeout(() => {
        if (!res.headersSent) {
            const indexToRemove = queue.findIndex(existingPlayer => existingPlayer.email === player.email);
            if (indexToRemove !== -1) {
                queue.splice(indexToRemove, 1);
            }
            res.json({ status: 'unmatched', join_time: player.joinTime });
        }
    }, 5000);
});

app.post('/game/timer', (req, res) => {
    const { time } = req.body;

    const parts = time.split(":");
    const minutes = parseInt(parts[0], 10);
    const seconds = parseInt(parts[1], 10);

    let totalSeconds = minutes * 60 + seconds;

    // 요청을 받은 후 1초 후에 응답을 보냅니다.
    setTimeout(() => {
        if (totalSeconds <= 0) {
            clearInterval(timerInterval);
            res.json({ time: '00:00' });
        }
        else {
            totalSeconds--;
            const displayMinutes = Math.floor(totalSeconds / 60);
            const displaySeconds = totalSeconds % 60;
            res.json({ time: `${displayMinutes.toString().padStart(2, '0')}:${displaySeconds.toString().padStart(2, '0')}` });
        }
    }, 1000);
});


app.post('/game/:game_id/chatting/connect', (req, res) => {
    const { game_id } = req.params;
    const { email } = req.body;

    // 게임 및 플레이어 정보 확인
    if (!games[game_id] || !games[game_id].players.some(player => player.email === email)) {
        return console.log('Game or player not found');
    }

    // 클라이언트로부터의 요청을 저장
    games[game_id].players.find(player => player.email === email).res = res;
    console.log('res 객체 저장 완료:');
    console.log(res);
    
    setTimeout(() => {
        if (!res.headersSent) {
            if (games[game_id] && games[game_id].players.some(player => player.email === email)) {
                res.json({ email: "", message: "" });
            }
        }
    }, 5000);
});

app.post('/game/:game_id/chatting/chat', (req, res) => {
    const game_id = req.params.game_id;
    const { email, message } = req.body;

    // 게임 정보 확인
    if (!games[game_id]) {
        return res.status(404).json({ error: 'Game not found' });
    }

    // 새로운 메시지를 게임의 모든 플레이어에게 보냅니다.
    games[game_id].players.forEach(player => {
        if (player.res) {
            player.res.json({ email: email, message: message });
            player.res = null; // 응답 객체 초기화
        }
    });
    console.log('Broadcasting 완료');

    res.json();
});

app.post('/game/:game_id/moves', (req, res) => {
    const { game_id } = req.params;
    const { square, email } = req.body;
    const sql = 'SELECT * FROM games WHERE game_id = ?';
    connection.query(sql, [game_id], function (err, results) {
        if (err) throw err;
        if (results.length > 0) {
            const game = results[0];
            // if (game.current_turn !== email) return res.status(403).send("Not your turn");
            const chess = new Chess(game.fen);
            const moves = chess.moves({ square: square, verbose: true });
            return res.json(moves);
        } else {
            return res.status(404).send("Game not found");
        }
    });
});

// 움직임을 실행
app.post('/game/:game_id/move', (req, res) => {
    const { game_id } = req.params;
    const { san, email } = req.body;
    console.log('move 요청 옴')
    let sql;
    sql = 'SELECT * FROM games WHERE game_id = ?';
    connection.query(sql, [game_id], function (err, results) {
        if (err) throw err;
        if (results.length > 0) {
            const game = results[0];
            // if (game.current_turn !== email) return res.status(403).send("Not your turn");
            const chess = new Chess(game.fen);
            let move;
            try {
                move = chess.move(san);
            }
            catch {
                console.log("Invalid move");
                return res.status(400).send("Invalid move");
            }
            game.fen = chess.fen();
            game.current_turn = (game.current_turn === game.player1_email) ? game.player2_email : game.player1_email;

            sql = 'UPDATE games SET fen = ?, current_turn = ? WHERE game_id = ?';
            connection.query(sql, [game.fen, game.current_turn, game_id]);

            sql = 'INSERT INTO moves (game_id, player_email, color, piece, move_from, move_to, flags, san) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
            connection.query(sql, [game_id, email].concat(Object.values(move)));

            return res.json({ fen: game.fen });
        } else {
            return res.status(404).send("Game not found");
        }
    });
});

app.post('/test', (req, res) => {
    games[0] = {
        players: [
            {
                email: 'test@test.com',
                res: null
            },
            {
                email: 'limjilab@gmail.com',
                res: null
            }
        ]
    };
    console.log('테스트 세팅 완료');
    res.json({});
});

app.listen(port, () => console.log(`Server is listening on port ${port}`));

module.exports = app;