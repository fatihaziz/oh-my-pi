// A socketless PTY child that emits output through graceful and forced teardown.
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", bytes => {
	if (Buffer.isBuffer(bytes) ? bytes.includes(3) : bytes.includes("\x03")) {
		process.stdout.write("final-output\r\n");
		process.exit(0);
	}
});
setInterval(() => process.stdout.write("tick\r\n"), 10);
