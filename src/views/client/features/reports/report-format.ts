export function formatMinutes(minutes: number | null): string {
	if (minutes === null) return "数据不足";
	if (minutes < 60) return `${minutes} 分钟`;
	const hours = Math.floor(minutes / 60);
	const remainder = minutes % 60;
	return remainder === 0 ? `${hours} 小时` : `${hours} 小时 ${remainder} 分`;
}

export function formatCount(value: number | null, suffix = "项"): string {
	return value === null ? "数据不足" : `${value} ${suffix}`;
}

export function formatRate(value: number | null): string {
	return value === null ? "数据不足" : `${value}%`;
}
