import { test } from "node:test";
import assert from "node:assert/strict";
import { planLayout } from "../../src/watch/layout.ts";

test("adaptive layout reserves the majority for the leader and fits nonoverlapping members", () => {
	for (const [width, height] of [[200, 60], [120, 40], [80, 24], [60, 80], [40, 100]]) {
		for (const count of [1, 2, 5, 11]) {
			const plan = planLayout(width, height, "%0", Array.from({ length: count }, (_, i) => `%${i + 1}`))!;
			assert.ok(plan, `${width}x${height} / ${count}`);
			assert.equal(plan.cells.length, count + 1);
			assert.ok(plan.cells[0].width * plan.cells[0].height > width * height * 0.5);
			for (const cell of plan.cells) {
				assert.ok(cell.width >= 4 && cell.height >= 3);
				assert.ok(cell.x >= 0 && cell.y >= 0 && cell.x + cell.width <= width && cell.y + cell.height <= height);
			}
			for (let i = 0; i < plan.cells.length; i++) for (let j = i + 1; j < plan.cells.length; j++) {
				const a = plan.cells[i], b = plan.cells[j];
				assert.ok(a.x + a.width < b.x || b.x + b.width < a.x || a.y + a.height < b.y || b.y + b.height < a.y);
			}
		}
	}
	assert.notEqual(planLayout(200, 40, "%0", ["%1", "%2"])!.orientation, planLayout(40, 100, "%0", ["%1", "%2"])!.orientation);
});

test("layout handles no members and rejects physically impossible allocations", () => {
	assert.equal(planLayout(80, 24, "%0", [])!.cells.length, 1);
	assert.equal(planLayout(8, 3, "%0", ["%1", "%2"]), undefined);
});
