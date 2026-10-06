import { useState, useEffect, useCallback } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import type { CalendarEvent } from "../types/calendar";
import { isSoloEvent } from "../helpers/calendarSoloEvent";

export interface UseUpcomingEventsReturn {
  events: CalendarEvent[];
  isLoading: boolean;
  isConnected: boolean;
}

const LOOKAHEAD_DAYS = 7;

function getLookaheadMinutes(): number {
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + LOOKAHEAD_DAYS);
  end.setHours(0, 0, 0, 0);
  return Math.max(1, Math.ceil((end.getTime() - now.getTime()) / 60000));
}

export function useUpcomingEvents(): UseUpcomingEventsReturn {
  const isConnected = useSettingsStore((s) => s.appleCalendarConnected);

  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const fetchEvents = useCallback(async () => {
    if (!isConnected) {
      setEvents([]);
      return;
    }
    setIsLoading(true);
    try {
      const windowMinutes = getLookaheadMinutes();
      const result = await window.electronAPI?.calendarGetUpcomingEvents?.(windowMinutes);
      if (result?.success && Array.isArray(result.events)) {
        setEvents(result.events.filter((event) => !isSoloEvent(event)));
      } else {
        setEvents([]);
      }
    } catch {
      setEvents([]);
    } finally {
      setIsLoading(false);
    }
  }, [isConnected]);

  // Fetch on mount and when connection status changes
  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  // Re-fetch when the calendar syncs events
  useEffect(() => {
    if (!isConnected) return;
    return window.electronAPI?.onAcalEventsSynced?.(() => {
      fetchEvents();
    });
  }, [isConnected, fetchEvents]);

  return { events, isLoading, isConnected };
}
