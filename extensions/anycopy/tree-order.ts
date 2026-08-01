export type OrderedTreeNode = {
	entry: { id: string };
	children: OrderedTreeNode[];
};

/** Build a pre-order DFS index for chronological sorting */
export const buildNodeOrder = (roots: OrderedTreeNode[]): Map<string, number> => {
	const order = new Map<string, number>();
	const stack = [...roots].reverse();
	let index = 0;

	while (stack.length > 0) {
		const node = stack.pop()!;
		order.set(node.entry.id, index++);
		for (let childIndex = node.children.length - 1; childIndex >= 0; childIndex -= 1) {
			stack.push(node.children[childIndex]!);
		}
	}

	return order;
};
