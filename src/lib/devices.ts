/**
 * A device as a person would name it, from its User-Agent string: "Safari
 * on iOS", "Chrome on Windows". For the device lists in Settings → Security
 * (sessions) and Settings → Notifications (push), where a row has nothing
 * else to go by.
 */
export function describeDevice(ua: string | null): string {
	if (!ua) return 'Unknown device';
	const browser = /Firefox\/|FxiOS\//.test(ua) ? 'Firefox'
		: /Edg\/|EdgiOS\//.test(ua) ? 'Edge'
		: /OPR\//.test(ua) ? 'Opera'
		: /Chrome\/|CriOS\//.test(ua) ? 'Chrome'
		: /Safari\//.test(ua) ? 'Safari'
		: 'Browser';
	// iPhones say "like Mac OS X" and Android says "Linux", so the specific
	// systems come first.
	const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS'
		: /Android/.test(ua) ? 'Android'
		: /Windows/.test(ua) ? 'Windows'
		: /CrOS/.test(ua) ? 'ChromeOS'
		: /Mac/.test(ua) ? 'macOS'
		: /Linux/.test(ua) ? 'Linux'
		: '';
	return os ? `${browser} on ${os}` : browser;
}

/**
 * "just now", "5m ago", "3h ago", "2d ago". Takes an ISO timestamp or the
 * `YYYY-MM-DD HH:MM:SS` SQLite writes, which is UTC without saying so.
 */
export function relativeTime(stamp: string, now: number = Date.now()): string {
	const iso = stamp.includes('T') ? stamp : stamp.replace(' ', 'T') + 'Z';
	const mins = Math.round((now - new Date(iso).getTime()) / 60000);
	if (mins < 1) return 'just now';
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.round(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}
