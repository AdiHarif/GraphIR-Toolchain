
import * as fs from "fs";

function partial_verify(board, x, y) {
	let base_x = Math.floor(x / 3) * 3;
	let base_y = Math.floor(y / 3) * 3;
	for (let i = 0; i < 9; i = i+1) {
		if (i != y && board[x][i] == board[x][y]) {
			return false;
		}
		if (i != x && board[i][y] == board[x][y]) {
			return false;
		}
		let pos_x = base_x + Math.floor(i / 3);
		let pos_y = base_y + (i % 3);
		if ((pos_x != x || pos_y != y) && board[pos_x][pos_y] == board[x][y]) {
			return false;
		}
	}
	return true;
}

// @ductape-export
function solve(board, x, y) {
	let z = x * 9 + y + 1;
	if (z == 82) {
		return true;
	}
	if (board[x][y] != 0) {
		return solve(board, Math.floor(z / 9), z % 9);
	}
	for (let i = 1; i <= 9; i = i+1) {
		board[x][y] = i;
		if (partial_verify(board, x, y)) {
			if (solve(board, Math.floor(z / 9), z % 9)) {
				return true;
			}
		}
	}
	board[x][y] = 0;
	return false;
}

function verify(board) {
	for (let i = 0; i < 9; i = i+1) {
		let row_check = new Array(10);
		let col_check = new Array(10);
		for (let j = 0; j < 9; j = j+1) {
			if (board[i][j] == 0) {
				return false;
			}
			if (row_check[board[i][j]]) {
				return false;
			}
			row_check[board[i][j]] = 1;

			if (col_check[board[j][i]]) {
				return false;
			}
			col_check[board[j][i]] = 1;
		}
	}

	for (let i = 0; i < 9; i = i + 3) {
		for (let j = 0; j < 9; j = j + 3) {
			let check = new Array(10);
			for (let k = 0; k < 9; k = k+1) {
				let x = i + Math.floor(k / 3);
				let y = j + (k % 3);
				if (check[board[x][y]]) {
					return false;
				}
				check[board[x][y]] = 1;
			}
		}
	}
	return true;
}

function read_line(line, board) {
	for (let i = 0; i < 9;  i = i+1) {
		for (let j = 0; j < 9; j = j+1) {
			let ch = line[i * 9 + j];
			if (ch == '.') {
				ch = '0';
			}
			board[i][j] = parseInt(ch) - parseInt('0');
		}
	}
	return;
}

function read_file(fname): string[] {
	let data = fs.readFileSync(fname, 'utf8');
	const lines = new Array<string>(64);
	for (let i = 0; i < 64; i = i + 1) {
		lines[i] = data.substring(i*82, (i+1)*82);
	}
	return lines;
}

function _main(args) {
	const lines = read_file(args[0]);
	const linesCount = lines.length;
	for (let i = 0; i < linesCount;  i = i+1) {
		let board = new Array(9);
		for (let j = 0; j < 9; j = j+1) {
			board[j] = new Array(9);
		}
		read_line(lines[i], board);
		solve(board, 0, 0);
		if (!verify(board)) {
			console.log("Verification failed");
		}
	}
	return;
}

const iterations = parseInt(process.argv[3])
for (let i = 0; i < iterations;  i = i+1) {
	_main(process.argv.slice(2));
}
