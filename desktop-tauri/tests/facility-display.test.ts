import { describe, expect, it } from "vitest";
import {
  FACILITY_DISPLAY_SCALE_DEFAULT,
  FACILITY_DISPLAY_SCALE_MAX,
  FACILITY_DISPLAY_SCALE_MIN,
  clampFacilityDisplayScale,
  facilityIconSizeExpression,
  facilityMarkerRadiusExpression,
} from "../src/workbench/facilityDisplay";

describe("facility display sizing", () => {
  it("clamps invalid and out-of-range display scales", () => {
    expect(clampFacilityDisplayScale(Number.NaN)).toBe(
      FACILITY_DISPLAY_SCALE_DEFAULT,
    );
    expect(clampFacilityDisplayScale(Number.POSITIVE_INFINITY)).toBe(
      FACILITY_DISPLAY_SCALE_DEFAULT,
    );
    expect(clampFacilityDisplayScale(0)).toBe(FACILITY_DISPLAY_SCALE_MIN);
    expect(clampFacilityDisplayScale(9)).toBe(FACILITY_DISPLAY_SCALE_MAX);
  });

  it("keeps distant facility icons hidden and scales them with zoom and user preference", () => {
    const expression = facilityIconSizeExpression(1.3);
    expect(expression[0]).toBe("interpolate");
    expect(expression).toContain(6.99);
    expect(expression).toContain(0);
    expect(expression).toContain(7);
    expect(expression).toContain(0.34 * 1.3);
    expect(facilityIconSizeExpression(100)).toContain(0.34 * 3);
  });

  it("gives selected markers a larger zoom-aware radius", () => {
    const expression = facilityMarkerRadiusExpression(1.3, "facility-a");
    expect(expression[0]).toBe("interpolate");
    expect(expression[2]).toEqual(["zoom"]);
    expect(JSON.stringify(expression)).toContain("facility-a");
    for (const index of [4, 6, 8, 10]) {
      expect(JSON.stringify(expression[index])).toContain('"case"');
    }

    const plainExpression = facilityMarkerRadiusExpression(-5);
    expect(plainExpression[0]).toBe("interpolate");
    expect(plainExpression[4]).toBe(4 * FACILITY_DISPLAY_SCALE_MIN * 0.72);

    const zoomOperators: unknown[][] = [];
    const visit = (value: unknown) => {
      if (!Array.isArray(value)) return;
      if (value[0] === "zoom") zoomOperators.push(value);
      value.forEach(visit);
    };
    visit(expression);
    expect(zoomOperators).toEqual([["zoom"]]);
  });
});
