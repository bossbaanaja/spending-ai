ALTER TABLE album_item_work ADD COLUMN card_message_id INTEGER;
CREATE TABLE album_queue_batches (
  batch_id INTEGER PRIMARY KEY REFERENCES slip_batches(id)
);
