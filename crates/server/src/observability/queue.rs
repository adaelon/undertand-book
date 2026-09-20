use serde_json::Value;
use std::collections::VecDeque;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportOperation {
    Create,
    Update,
}

#[derive(Debug, Clone)]
pub struct ExportItem {
    pub root_run_id: String,
    pub run_id: String,
    pub parent_run_id: Option<String>,
    pub revision: u32,
    pub operation: ExportOperation,
    pub payload: Value,
    encoded_bytes: usize,
}

impl ExportItem {
    pub fn new(
        root_run_id: String,
        run_id: String,
        parent_run_id: Option<String>,
        revision: u32,
        operation: ExportOperation,
        payload: Value,
    ) -> Self {
        let encoded_bytes = serde_json::to_vec(&payload)
            .map(|bytes| bytes.len())
            .unwrap_or(0);
        Self {
            root_run_id,
            run_id,
            parent_run_id,
            revision,
            operation,
            payload,
            encoded_bytes,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct QueueLimits {
    pub max_items: usize,
    pub max_bytes: usize,
    pub max_item_bytes: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QueueDropReason {
    ItemTooLarge,
    Capacity,
    Closed,
}

struct QueueState {
    items: VecDeque<ExportItem>,
    bytes: usize,
    accepting: bool,
    shutdown_at: Option<Instant>,
}

pub struct BoundedQueue {
    limits: QueueLimits,
    state: Mutex<QueueState>,
    wake: Condvar,
}

impl BoundedQueue {
    pub fn new(limits: QueueLimits) -> Self {
        Self {
            limits,
            state: Mutex::new(QueueState {
                items: VecDeque::new(),
                bytes: 0,
                accepting: true,
                shutdown_at: None,
            }),
            wake: Condvar::new(),
        }
    }

    pub fn try_push(&self, item: ExportItem) -> Result<(), QueueDropReason> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if !state.accepting {
            return Err(QueueDropReason::Closed);
        }
        if item.encoded_bytes > self.limits.max_item_bytes {
            return Err(QueueDropReason::ItemTooLarge);
        }
        if state.items.len() >= self.limits.max_items
            || state.bytes.saturating_add(item.encoded_bytes) > self.limits.max_bytes
        {
            return Err(QueueDropReason::Capacity);
        }
        state.bytes += item.encoded_bytes;
        state.items.push_back(item);
        self.wake.notify_one();
        Ok(())
    }

    pub fn pop(&self) -> Option<ExportItem> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        loop {
            if state
                .shutdown_at
                .is_some_and(|deadline| Instant::now() >= deadline)
            {
                state.items.clear();
                state.bytes = 0;
                return None;
            }
            if let Some(item) = state.items.pop_front() {
                state.bytes = state.bytes.saturating_sub(item.encoded_bytes);
                return Some(item);
            }
            if !state.accepting {
                return None;
            }
            state = self
                .wake
                .wait(state)
                .unwrap_or_else(|error| error.into_inner());
        }
    }

    pub fn begin_shutdown(&self, budget: Duration) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.accepting = false;
        state.shutdown_at = Some(Instant::now() + budget);
        self.wake.notify_all();
    }

    pub fn remaining_shutdown_budget(&self) -> Option<Duration> {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .shutdown_at
            .map(|deadline| deadline.saturating_duration_since(Instant::now()))
    }

    pub fn pending(&self) -> (usize, usize) {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        (state.items.len(), state.bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item(id: &str, body: Value) -> ExportItem {
        ExportItem::new(id.into(), id.into(), None, 1, ExportOperation::Create, body)
    }

    #[test]
    fn queue_rejects_without_blocking_when_capacity_or_item_limit_is_hit() {
        let queue = BoundedQueue::new(QueueLimits {
            max_items: 1,
            max_bytes: 100,
            max_item_bytes: 30,
        });
        queue.try_push(item("one", json!({"id":"one"}))).unwrap();
        assert_eq!(
            queue.try_push(item("two", json!({"id":"two"}))),
            Err(QueueDropReason::Capacity)
        );
        let oversized = item("large", json!({"data":"x".repeat(100)}));
        assert_eq!(
            queue.try_push(oversized),
            Err(QueueDropReason::ItemTooLarge)
        );
    }

    #[test]
    fn shutdown_stops_new_items_and_allows_existing_work_within_budget() {
        let queue = BoundedQueue::new(QueueLimits {
            max_items: 2,
            max_bytes: 1_000,
            max_item_bytes: 500,
        });
        queue.try_push(item("one", json!({"id":"one"}))).unwrap();
        queue.begin_shutdown(Duration::from_secs(1));
        assert_eq!(
            queue.try_push(item("two", json!({"id":"two"}))),
            Err(QueueDropReason::Closed)
        );
        assert_eq!(queue.pop().unwrap().run_id, "one");
        assert!(queue.pop().is_none());
    }
}
