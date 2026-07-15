import assert from "node:assert/strict";
import { test } from "node:test";

import { getClientRestaurantScheduleSummary } from "./selectors.ts";
import type { DaySchedule, Restaurant, WeeklySchedule } from "./models.ts";

const CLOSED: DaySchedule = { enabled: false, openTime: "", closeTime: "" };

function week(overrides: Partial<Record<keyof WeeklySchedule, DaySchedule>>): WeeklySchedule {
  const base: WeeklySchedule = {
    monday: CLOSED,
    tuesday: CLOSED,
    wednesday: CLOSED,
    thursday: CLOSED,
    friday: CLOSED,
    saturday: CLOSED,
    sunday: CLOSED,
  };
  return { ...base, ...overrides };
}

function restaurant(
  weeklySchedule: WeeklySchedule,
  timeZone = "UTC",
): Restaurant {
  return { weeklySchedule, timeZone } as unknown as Restaurant;
}

const open9to22: DaySchedule = { enabled: true, openTime: "09:00", closeTime: "22:00" };
const night18to02: DaySchedule = { enabled: true, openTime: "18:00", closeTime: "02:00" };

test("§1: обычный открытый день", () => {
  const r = restaurant(week({ monday: open9to22 }));
  const s = getClientRestaurantScheduleSummary(r, new Date("2021-01-04T12:00:00Z"));
  assert.equal(s.currentWeekdayId, "monday");
  assert.equal(s.isOpen, true);
  assert.equal(s.statusText, "Сегодня: 09:00–22:00 · Сейчас открыто");
});

test("§1: обычный закрытый день", () => {
  const r = restaurant(week({}));
  const s = getClientRestaurantScheduleSummary(r, new Date("2021-01-04T12:00:00Z"));
  assert.equal(s.isOpen, false);
  assert.equal(s.statusText, "Сегодня: Закрыто · Сейчас закрыто");
});

test("§1: до открытия", () => {
  const r = restaurant(week({ monday: open9to22 }));
  const s = getClientRestaurantScheduleSummary(r, new Date("2021-01-04T07:00:00Z"));
  assert.equal(s.isOpen, false);
  assert.equal(s.statusText, "Сегодня: 09:00–22:00 · Сейчас закрыто");
});

test("§1: после закрытия", () => {
  const r = restaurant(week({ monday: open9to22 }));
  const s = getClientRestaurantScheduleSummary(r, new Date("2021-01-04T23:00:00Z"));
  assert.equal(s.isOpen, false);
  assert.equal(s.statusText, "Сегодня: 09:00–22:00 · Сейчас закрыто");
});

test("§1: ночной интервал 18:00–02:00 до полуночи", () => {
  const r = restaurant(week({ saturday: night18to02 }));
  const s = getClientRestaurantScheduleSummary(r, new Date("2021-01-09T20:00:00Z"));
  assert.equal(s.currentWeekdayId, "saturday");
  assert.equal(s.isOpen, true);
  assert.equal(s.activeScheduleWeekdayId, "saturday");
  assert.equal(s.statusText, "Сегодня: 18:00–02:00 · Сейчас открыто");
});

test("§1: ночной интервал после полуночи — без противоречия", () => {
  // Суббота 18:00–02:00, воскресенье закрыто, сейчас вс 01:00.
  const r = restaurant(week({ saturday: night18to02 }));
  const s = getClientRestaurantScheduleSummary(r, new Date("2021-01-10T01:00:00Z"));
  assert.equal(s.currentWeekdayId, "sunday");
  assert.equal(s.isOpen, true);
  assert.equal(s.activeScheduleWeekdayId, "saturday");
  assert.equal(s.todayScheduleLabel, "Закрыто");
  assert.equal(s.statusText, "Сейчас открыто до 02:00 · Сегодня: Закрыто");
  // Никогда не «Сегодня: Закрыто · Сейчас открыто».
  assert.ok(!s.statusText.includes("Закрыто · Сейчас открыто"));
});

test("§1: следующий день полностью закрыт после ночного интервала", () => {
  const r = restaurant(week({ saturday: night18to02 }));
  const s = getClientRestaurantScheduleSummary(r, new Date("2021-01-10T03:00:00Z"));
  assert.equal(s.currentWeekdayId, "sunday");
  assert.equal(s.isOpen, false);
  assert.equal(s.statusText, "Сегодня: Закрыто · Сейчас закрыто");
});

test("§1: расчёт в часовом поясе ресторана, а не по UTC", () => {
  // Инстант — понедельник 02:00 UTC = воскресенье 21:00 в Нью-Йорке (EST).
  const r = restaurant(week({ sunday: open9to22 }), "America/New_York");
  const s = getClientRestaurantScheduleSummary(r, new Date("2021-01-04T02:00:00Z"));
  assert.equal(s.currentWeekdayId, "sunday");
  assert.equal(s.isOpen, true);
  assert.equal(s.statusText, "Сегодня: 09:00–22:00 · Сейчас открыто");
});
