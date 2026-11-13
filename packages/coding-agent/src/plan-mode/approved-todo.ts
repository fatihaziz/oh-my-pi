import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

/** Extract the last top-level section without interpreting headings or checkboxes inside fenced code. */
export function extractApprovedTodo(plan: string): { objective: string; phases: TodoPhase[] } | undefined {
	const lines = plan.split(/(?<=\n)/);
	let fence: { char: string; length: number } | undefined;
	let offset = 0;
	let headingOffset = -1;
	let headingLine = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].replace(/\r?\n$/, "");
		const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (marker) {
			if (!fence) fence = { char: marker[0], length: marker.length };
			else if (
				marker[0] === fence.char &&
				marker.length >= fence.length &&
				/^\s*$/.test(line.slice(line.indexOf(marker) + marker.length))
			)
				fence = undefined;
		} else if (!fence && /^##(?:\s|$)/.test(line)) {
			headingOffset = /^## Todo\s*$/.test(line) ? offset : -1;
			headingLine = i;
		}
		offset += lines[i].length;
	}
	if (headingOffset < 0) return undefined;
	const tasks: TodoPhase["tasks"] = [];
	fence = undefined;
	for (let i = headingLine + 1; i < lines.length; i++) {
		const line = lines[i].replace(/\r?\n$/, "");
		const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (marker) {
			if (!fence) fence = { char: marker[0], length: marker.length };
			else if (
				marker[0] === fence.char &&
				marker.length >= fence.length &&
				/^\s*$/.test(line.slice(line.indexOf(marker) + marker.length))
			)
				fence = undefined;
		}
		if (!fence && !marker && /^\s*(?:[-+*]|\d+[.)])\s+\[[ xX]\]\s*$/.test(line)) return undefined;
		const match = !fence && !marker ? /^\s*(?:[-+*]|\d+[.)])\s+\[([ xX])\]\s+(.+?)\s*$/.exec(line) : undefined;
		if (match) tasks.push({ content: match[2], status: match[1].toLowerCase() === "x" ? "completed" : "pending" });
		else if (line.trim() && tasks.length) tasks[tasks.length - 1].content += `\n${line.trimStart()}`;
	}
	if (!tasks.length) return undefined;
	const firstPending = tasks.find(task => task.status === "pending");
	if (firstPending) firstPending.status = "in_progress";
	return { objective: plan.slice(headingOffset).trimEnd(), phases: [{ name: "Todo", tasks }] };
}
