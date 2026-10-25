function safeMessage(error) {
  return String(error?.message || 'Unknown Supabase error')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '[identifier redacted]')
    .replace(/\b[A-F0-9]{6}\b/g, '[room code redacted]')
    .replace(/Key\s+\([^)]*\)\s*=\s*\([^)]*\)/gi, 'Key values [redacted]')
    .replace(/\b(search|steal|trap|guard|dig_deep|explore)\b/gi, '[private action]')
    .slice(0, 240);
}

export function logSupabaseError(operation, error, isDev) {
  if (!isDev) return;
  console.error(`[Treasure Plots] ${operation} failed`, {
    code: error?.code || null,
    message: safeMessage(error),
  });
}

export function explainSupabaseError(error, operation = 'request') {
  const message = String(error?.message || '').toLowerCase();
  const code = String(error?.code || '');
  if (code === 'PGRST202' || message.includes('schema cache') || message.includes('could not find the function')) {
    return 'The game database is missing the required RPC. Confirm Migration 002 is installed.';
  }
  if (operation === 'submit_action') {
    if (code === '21000') return 'The database returned multiple rows where one was expected (error 21000). This RPC failed as one transaction, so its move should have rolled back; check the room state before retrying.';
    if (message.includes('game is not accepting choices')) {
      return 'This round is no longer accepting moves. The room is being refreshed; check the current round before choosing again.';
    }
    if (message.includes('not an active player')) {
      return 'Your player is no longer active in this room. Rejoin using the room code, then try again.';
    }
    if (message.includes('choice already locked') || message.includes('already locked') || code === '23505') {
      return 'A move is already locked for you this round. Your existing move stays hidden; the room is being refreshed.';
    }
    if (message.includes('choose a valid rival') || code === '23503') {
      return 'That target is no longer available in this room. Refresh and choose an active rival.';
    }
    if (message.includes('invalid action')) return 'That move is not supported by the server. Refresh the game and choose one of the available moves.';
    if (message.includes('need 1 coin') || message.includes('insufficient coins')) return 'You do not have enough coins for that move.';
    if (message.includes('network') || message.includes('fetch')) return 'The move request lost its connection. The room is being refreshed; do not resubmit until it updates.';
    if (code === '42501') return 'Supabase denied this move for the current session. Rejoin the room and try again.';
    return `Supabase rejected this move${code ? ` (error ${code})` : ''}. The room is being refreshed; check the browser console in development for the sanitized server message.`;
  }
  if (operation === 'get_room') {
    if (code === '21000') return 'The room refresh hit a database cardinality error (21000). An earlier accepted move may already be locked; do not resubmit until the room can be read.';
    return `The room state could not refresh${code ? ` (error ${code})` : ''}. Check the connection; a submitted move may already be locked.`;
  }
  return null;
}
