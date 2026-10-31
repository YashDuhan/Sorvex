import { Folder, GitBranch } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api.ts";

/**
 * Shown under a new chat's composer, like Claude Code's: the folder the agent works in (click to change it) and the
 * git branch checked out there.
 */
export function ContextChips({ cwd, refreshKey, onChangeCwd }: { cwd: string; refreshKey: number; onChangeCwd: () => void }) {
	const [branch, setBranch] = useState<string | undefined>();

	useEffect(() => {
		let cancelled = false;
		void api<{ branch?: string }>("POST", "/api/git/branch").then(
			(result) => !cancelled && setBranch(result.branch),
			() => !cancelled && setBranch(undefined),
		);
		return () => {
			cancelled = true;
		};
	}, [cwd, refreshKey]);

	if (!cwd) return null;
	const name = cwd.replace(/\/+$/, "").split("/").pop() || cwd;
	return (
		<div className="context-chips">
			<button type="button" className="context-chip" title={`${cwd}\nClick to change the folder`} onClick={onChangeCwd}>
				<Folder size={14} />
				<span>{name}</span>
			</button>
			{branch && (
				<span className="context-chip static" title={`Branch: ${branch}`}>
					<GitBranch size={14} />
					<span>{branch}</span>
				</span>
			)}
		</div>
	);
}
