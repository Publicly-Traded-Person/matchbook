import { expect, test } from "bun:test"
import { HOURS_PER_WEEK } from "../src/types"

test("a week is 168 hours", () => {
  expect(HOURS_PER_WEEK).toBe(168)
})
