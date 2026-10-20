import { useEffect, useRef, useState } from 'react';

/**
 * The farm target as toggles: any set of skills, or pp.
 *
 * A dropdown could pick exactly one of fourteen things and hid the other
 * thirteen, which made "everything but the two I am levelling" - the thing a
 * player farming for an upgrade actually wants - impossible to say. Toggles
 * say it directly: a skill the ranking should ignore is simply switched off,
 * and the ranking re-sorts on the spot, no scan repeated.
 *
 * pp stays apart from the skills, because it is not one: it is score, not XP,
 * and ranks per play rather than per second (see `metrics.ts`). Toggling it on
 * suspends the skill selection rather than clearing it, so switching back
 * loses nothing.
 *
 * The popover mechanics mirror `RatePicker`: click away or Escape closes, and
 * the trigger is the summary of what is on.
 */
export default function TargetPicker({
	skills,
	selected,
	pp,
	onChange,
}: {
	/** Every skill the game tracks, in its own order. */
	skills: string[];
	/** Which of them the ranking counts. Never empty - see the toggle guard. */
	selected: string[];
	/** Whether the ranking is by pp instead of by skill XP. */
	pp: boolean;
	/** The new selection, as a whole. */
	onChange: (next: { selected: string[]; pp: boolean }) => void;
}) {
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const away = (e: Event) => {
			if (root.current && !e.composedPath().includes(root.current)) setOpen(false);
		};
		const escape = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
		window.addEventListener('pointerdown', away);
		window.addEventListener('keydown', escape);
		return () => {
			window.removeEventListener('pointerdown', away);
			window.removeEventListener('keydown', escape);
		};
	}, [open]);

	const isOn = (skill: string) => !pp && selected.includes(skill);

	const toggleSkill = (skill: string) => {
		const on = selected.includes(skill);
		// The last skill stays on: an empty selection ranks nothing at all, and
		// "total" is one All-click away rather than an accident away.
		if (on && selected.length === 1 && !pp) return;
		// Clicking a skill while pp is active leaves pp - the click says which
		// skill is wanted, and pp is not one.
		onChange({
			selected: on ? selected.filter(other => other !== skill) : [...selected, skill],
			pp: false,
		});
	};

	const all = selected.length === skills.length;

	const summary = pp
		? 'pp'
		: all
			? 'Total XP'
			: selected.length === 1
				? `${selected[0]} XP`
				: `${selected.length} skills`;

	return (
		<div className="picker" ref={root}>
			<button className="picker-trigger" aria-expanded={open} onClick={() => setOpen(!open)}>
				{summary}
			</button>

			{open && (
				<div className="picker-menu">
					<div className="chips">
						{skills.map(skill => (
							<button
								key={skill}
								className={['chip', isOn(skill) ? 'on' : '', pp ? 'dim' : ''].join(' ')}
								aria-pressed={isOn(skill)}
								onClick={() => toggleSkill(skill)}
							>
								{skill}
							</button>
						))}
					</div>

					<div className="picker-row">
						<button
							className={['chip', 'pp', pp ? 'on' : ''].join(' ')}
							aria-pressed={pp}
							title="Score per play, not XP per second - the footer explains while it is the target."
							onClick={() => onChange({ selected, pp: !pp })}
						>
							pp
						</button>
						<span className="spacer" style={{ flex: 1 }} />
						<button
							className="preset"
							title="Every skill - the total XP ranking."
							onClick={() => onChange({ selected: [...skills], pp: false })}
						>
							All
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
