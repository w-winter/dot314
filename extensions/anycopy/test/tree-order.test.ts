import assert from "node:assert/strict";
import test from "node:test";

import { buildNodeOrder, type OrderedTreeNode } from "../tree-order.ts";

const createNode = (id: string, children: OrderedTreeNode[] = []): OrderedTreeNode => ({
	entry: { id },
	children,
});

test("buildNodeOrder assigns pre-order indexes across branches", () => {
	const order = buildNodeOrder([
		createNode("root", [createNode("first", [createNode("first-child")]), createNode("second")]),
	]);

	assert.deepEqual([...order.entries()], [
		["root", 0],
		["first", 1],
		["first-child", 2],
		["second", 3],
	]);
});

test("buildNodeOrder handles session trees deeper than the call stack", () => {
	const nodeCount = 5_000;
	let tree = createNode(String(nodeCount - 1));
	for (let index = nodeCount - 2; index >= 0; index -= 1) {
		tree = createNode(String(index), [tree]);
	}

	const order = buildNodeOrder([tree]);

	assert.equal(order.size, nodeCount);
	assert.equal(order.get("0"), 0);
	assert.equal(order.get(String(nodeCount - 1)), nodeCount - 1);
});
