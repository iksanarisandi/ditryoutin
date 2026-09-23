-- Index untuk query yang sering dipakai
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX idx_questions_package_id ON questions(package_id);
CREATE INDEX idx_questions_category_id ON questions(category_id);
CREATE INDEX idx_attempts_user_id ON attempts(user_id);
CREATE INDEX idx_attempts_package_id ON attempts(package_id);
CREATE INDEX idx_attempts_status ON attempts(status);
CREATE INDEX idx_attempt_questions_attempt_id ON attempt_questions(attempt_id, question_order);
CREATE INDEX idx_attempt_questions_question_id ON attempt_questions(question_id);
CREATE INDEX idx_payments_user_id ON payments(user_id);
CREATE INDEX idx_payments_status ON payments(status);
CREATE INDEX idx_passing_grades_package_id ON passing_grades(package_id);
CREATE INDEX idx_users_access_expires_at ON users(access_expires_at);
