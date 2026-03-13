import { describe, expect, test } from "bun:test";
import {
  buildActionPanelTabStyle,
  buildPenaltyHeaderStyle,
  buildPenaltyNeutralChipStyle,
  buildPenaltyPanelBorderStyle,
  buildPenaltyPanelTintStyle,
  buildScoreDownButtonStyle,
  buildScoreUpButtonStyle,
  buildScoreValueStyle,
} from "@/lib/score-color-theme";
import { DEFAULT_AWAY_TEAM_COLOR, DEFAULT_HOME_TEAM_COLOR } from "@/lib/team-colors";

describe("score-color-theme", () => {
  test("matches previous default up-button visuals through algorithmic family mapping", () => {
    const home = buildScoreUpButtonStyle(DEFAULT_HOME_TEAM_COLOR);
    const away = buildScoreUpButtonStyle(DEFAULT_AWAY_TEAM_COLOR);

    expect(home.borderColor).toBe("oklch(82.8% 0.111 230.318)");
    expect(home.backgroundImage).toBe(
      "linear-gradient(to bottom right in oklab, oklch(68.5% 0.169 237.323), oklch(71.5% 0.143 215.221))",
    );
    expect(home.color).toBe("#ffffff");

    expect(away.borderColor).toBe("oklch(83.7% 0.128 66.29)");
    expect(away.backgroundImage).toBe(
      "linear-gradient(to bottom right in oklab, oklch(70.5% 0.213 47.604), oklch(64.5% 0.246 16.439))",
    );
    expect(away.color).toBe("#ffffff");
  });

  test("matches previous default down and value box visuals through algorithmic family mapping", () => {
    const home = buildScoreDownButtonStyle(DEFAULT_HOME_TEAM_COLOR);
    const away = buildScoreDownButtonStyle(DEFAULT_AWAY_TEAM_COLOR);
    const homeValue = buildScoreValueStyle(DEFAULT_HOME_TEAM_COLOR);
    const awayValue = buildScoreValueStyle(DEFAULT_AWAY_TEAM_COLOR);

    expect(home.borderColor).toBe("oklch(90.1% 0.058 230.902)");
    expect(home.backgroundColor).toBe("#ffffff");
    expect(home.color).toBe("oklch(50% 0.134 242.749)");
    expect(away.borderColor).toBe("oklch(90.1% 0.076 70.697)");
    expect(away.backgroundColor).toBe("#ffffff");
    expect(away.color).toBe("oklch(55.3% 0.195 38.402)");

    expect(homeValue.borderColor).toBe("oklch(90.1% 0.058 230.902)");
    expect(homeValue.boxShadow).toBe("inset 0 0 12px oklch(68.469% 0.148 237.323 / 0.18)");
    expect(awayValue.borderColor).toBe("oklch(90.1% 0.076 70.697)");
    expect(awayValue.boxShadow).toBe("inset 0 0 12px oklch(70.487% 0.187 47.604 / 0.16)");
  });

  test("matches previous default penalty-panel visuals through algorithmic family mapping", () => {
    const homeBorder = buildPenaltyPanelBorderStyle(DEFAULT_HOME_TEAM_COLOR);
    const awayHeader = buildPenaltyHeaderStyle(DEFAULT_AWAY_TEAM_COLOR);
    const homeHeader = buildPenaltyHeaderStyle(DEFAULT_HOME_TEAM_COLOR);
    const homeChip = buildPenaltyNeutralChipStyle(DEFAULT_HOME_TEAM_COLOR);
    const awayChip = buildPenaltyNeutralChipStyle(DEFAULT_AWAY_TEAM_COLOR);
    const leftTint = buildPenaltyPanelTintStyle(DEFAULT_HOME_TEAM_COLOR, "left");
    const rightTint = buildPenaltyPanelTintStyle(DEFAULT_AWAY_TEAM_COLOR, "right");

    expect(homeBorder.borderColor).toBe("oklch(90.1% 0.058 230.902)");
    expect(homeHeader.color).toBe("oklch(44.3% 0.11 240.79)");
    expect(awayHeader.color).toBe("oklch(47% 0.157 37.304)");
    expect(homeChip).toEqual({
      borderColor: "oklch(90.1% 0.058 230.902)",
      backgroundColor: "oklch(97.7% 0.013 236.62 / 0.8)",
      color: "#0f172a",
    });
    expect(awayChip).toEqual({
      borderColor: "oklch(90.1% 0.076 70.697)",
      backgroundColor: "oklch(98% 0.016 73.684 / 0.75)",
      color: "#0f172a",
    });
    expect(leftTint.backgroundImage).toBe(
      "radial-gradient(circle at 12% 18%, oklch(68.469% 0.148 237.323 / 0.14), oklch(68.469% 0.148 237.323 / 0.05) 34%, rgba(255,255,255,0) 68%), linear-gradient(180deg, oklch(97.7% 0.013 236.62 / 0.9), rgba(255,255,255,0.95) 32%, rgba(255,255,255,0.98))",
    );
    expect(rightTint.backgroundImage).toBe(
      "radial-gradient(circle at 88% 18%, oklch(70.487% 0.187 47.604 / 0.16), oklch(70.487% 0.187 47.604 / 0.05) 34%, rgba(255,255,255,0) 68%), linear-gradient(180deg, oklch(98% 0.016 73.684 / 0.88), rgba(255,255,255,0.95) 32%, rgba(255,255,255,0.98))",
    );
  });

  test("matches previous default bottom-tab visuals through algorithmic family mapping", () => {
    const card = buildActionPanelTabStyle("card", DEFAULT_HOME_TEAM_COLOR);
    const timeout = buildActionPanelTabStyle("timeout", DEFAULT_AWAY_TEAM_COLOR);
    const game = buildActionPanelTabStyle("game", DEFAULT_HOME_TEAM_COLOR, DEFAULT_AWAY_TEAM_COLOR);

    expect(card.backgroundImage).toBe(
      "linear-gradient(to bottom right in oklab, oklch(71.5% 0.143 215.221), oklch(58.8% 0.158 241.966))",
    );
    expect(card.boxShadow).toBe("0 0 14px oklch(74.6% 0.16 232.661 / 0.55)");
    expect(card.color).toBe("#ffffff");
    expect(timeout.backgroundImage).toBe(
      "linear-gradient(to bottom right in oklab, oklch(70.5% 0.213 47.604), oklch(76.9% 0.188 70.08))",
    );
    expect(timeout.boxShadow).toBe("0 0 14px oklch(75% 0.183 55.934 / 0.5)");
    expect(timeout.color).toBe("#ffffff");
    expect(game.backgroundImage).toBe(
      "linear-gradient(to bottom right in oklab, oklch(64.503% 0.215 16.439), oklch(59.147% 0.257 322.896))",
    );
    expect(game.boxShadow).toBe("0 0 14px oklch(64.503% 0.215 16.439 / 0.55)");
    expect(game.color).toBe("#ffffff");
  });

  test("uses the same structural algorithm for near-default colors", () => {
    const nearHome = buildScoreUpButtonStyle("#14a2e6");
    const nearAway = buildScoreUpButtonStyle("#f67a1c");
    expect(nearHome.backgroundImage).toContain("linear-gradient(to bottom right in oklab");
    expect(nearAway.backgroundImage).toContain("linear-gradient(to bottom right in oklab");
    expect(nearHome.backgroundImage).toContain("oklch(");
    expect(nearAway.backgroundImage).toContain("oklch(");
  });
});
