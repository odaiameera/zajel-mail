import type { LucideIcon } from '@lucide/svelte';
import AlarmClock from '@lucide/svelte/icons/alarm-clock';
import AlarmClockOff from '@lucide/svelte/icons/alarm-clock-off';
import ALargeSmall from '@lucide/svelte/icons/a-large-small';
import Archive from '@lucide/svelte/icons/archive';
import ArrowDown from '@lucide/svelte/icons/arrow-down';
import ArrowLeft from '@lucide/svelte/icons/arrow-left';
import ArrowUp from '@lucide/svelte/icons/arrow-up';
import ArrowUpDown from '@lucide/svelte/icons/arrow-up-down';
import Baseline from '@lucide/svelte/icons/baseline';
import Bell from '@lucide/svelte/icons/bell';
import BellDot from '@lucide/svelte/icons/bell-dot';
import Bold from '@lucide/svelte/icons/bold';
import Calendar from '@lucide/svelte/icons/calendar';
import CalendarClock from '@lucide/svelte/icons/calendar-clock';
import CalendarPlus from '@lucide/svelte/icons/calendar-plus';
import Camera from '@lucide/svelte/icons/camera';
import Check from '@lucide/svelte/icons/check';
import ChevronDown from '@lucide/svelte/icons/chevron-down';
import ChevronLeft from '@lucide/svelte/icons/chevron-left';
import ChevronRight from '@lucide/svelte/icons/chevron-right';
import ChevronUp from '@lucide/svelte/icons/chevron-up';
import CircleAlert from '@lucide/svelte/icons/circle-alert';
import CircleQuestionMark from '@lucide/svelte/icons/circle-question-mark';
import Clock from '@lucide/svelte/icons/clock';
import ContactRound from '@lucide/svelte/icons/contact-round';
import Copy from '@lucide/svelte/icons/copy';
import Download from '@lucide/svelte/icons/download';
import Ellipsis from '@lucide/svelte/icons/ellipsis';
import FaceSlightlySmiling from '@lucide/svelte/icons/face-slightly-smiling';
import File from '@lucide/svelte/icons/file';
import FileImage from '@lucide/svelte/icons/file-image';
import FileMusic from '@lucide/svelte/icons/file-music';
import FilePenLine from '@lucide/svelte/icons/file-pen-line';
import FileText from '@lucide/svelte/icons/file-text';
import FileVideoCamera from '@lucide/svelte/icons/file-video-camera';
import Folder from '@lucide/svelte/icons/folder';
import FolderInput from '@lucide/svelte/icons/folder-input';
import Forward from '@lucide/svelte/icons/forward';
import Funnel from '@lucide/svelte/icons/funnel';
import Highlighter from '@lucide/svelte/icons/highlighter';
import Hourglass from '@lucide/svelte/icons/hourglass';
import Inbox from '@lucide/svelte/icons/inbox';
import Italic from '@lucide/svelte/icons/italic';
import KeyRound from '@lucide/svelte/icons/key-round';
import Link from '@lucide/svelte/icons/link';
import List from '@lucide/svelte/icons/list';
import ListOrdered from '@lucide/svelte/icons/list-ordered';
import LoaderCircle from '@lucide/svelte/icons/loader-circle';
import LogIn from '@lucide/svelte/icons/log-in';
import LogOut from '@lucide/svelte/icons/log-out';
import Mail from '@lucide/svelte/icons/mail';
import MailDot from '@lucide/svelte/icons/mail-dot';
import MailOpen from '@lucide/svelte/icons/mail-open';
import MapPin from '@lucide/svelte/icons/map-pin';
import Maximize2 from '@lucide/svelte/icons/maximize-2';
import Menu from '@lucide/svelte/icons/menu';
import Minimize2 from '@lucide/svelte/icons/minimize-2';
import Minus from '@lucide/svelte/icons/minus';
import MoveDown from '@lucide/svelte/icons/move-down';
import MoveUp from '@lucide/svelte/icons/move-up';
import Newspaper from '@lucide/svelte/icons/newspaper';
import NotepadText from '@lucide/svelte/icons/notepad-text';
import PanelLeftClose from '@lucide/svelte/icons/panel-left-close';
import PanelLeftOpen from '@lucide/svelte/icons/panel-left-open';
import PanelRight from '@lucide/svelte/icons/panel-right';
import PanelsTopLeft from '@lucide/svelte/icons/panels-top-left';
import Paperclip from '@lucide/svelte/icons/paperclip';
import Pencil from '@lucide/svelte/icons/pencil';
import PilcrowLeft from '@lucide/svelte/icons/pilcrow-left';
import Plus from '@lucide/svelte/icons/plus';
import Printer from '@lucide/svelte/icons/printer';
import RefreshCw from '@lucide/svelte/icons/refresh-cw';
import RemoveFormatting from '@lucide/svelte/icons/remove-formatting';
import Repeat from '@lucide/svelte/icons/repeat';
import Reply from '@lucide/svelte/icons/reply';
import ReplyAll from '@lucide/svelte/icons/reply-all';
import RotateCcwClock from '@lucide/svelte/icons/rotate-ccw-clock';
import Search from '@lucide/svelte/icons/search';
import SearchX from '@lucide/svelte/icons/search-x';
import Send from '@lucide/svelte/icons/send';
import Settings from '@lucide/svelte/icons/settings';
import ShieldAlert from '@lucide/svelte/icons/shield-alert';
import ShieldCheck from '@lucide/svelte/icons/shield-check';
import Signature from '@lucide/svelte/icons/signature';
import Sparkles from '@lucide/svelte/icons/sparkles';
import SquareCheck from '@lucide/svelte/icons/square-check';
import SquarePen from '@lucide/svelte/icons/square-pen';
import Star from '@lucide/svelte/icons/star';
import Strikethrough from '@lucide/svelte/icons/strikethrough';
import Tag from '@lucide/svelte/icons/tag';
import TextAlignCenter from '@lucide/svelte/icons/text-align-center';
import TextAlignEnd from '@lucide/svelte/icons/text-align-end';
import TextAlignStart from '@lucide/svelte/icons/text-align-start';
import TextQuote from '@lucide/svelte/icons/text-quote';
import Trash from '@lucide/svelte/icons/trash';
import Underline from '@lucide/svelte/icons/underline';
import UserKey from '@lucide/svelte/icons/user-key';
import UserPlus from '@lucide/svelte/icons/user-plus';
import Users from '@lucide/svelte/icons/users';
import X from '@lucide/svelte/icons/x';
import ZoomIn from '@lucide/svelte/icons/zoom-in';
import ZoomOut from '@lucide/svelte/icons/zoom-out';

/**
 * Every icon in the app, named by the job it does rather than by what it
 * shows. One job, one drawing: to change how a job looks, change its line
 * here. A drawing can serve more than one name only where the jobs are the
 * same thing seen from two places (the Trash folder and Delete, Starred and
 * Star), never two different meanings.
 *
 * Drawings are Lucide's. See Icon.svelte for size and stroke.
 */
export const ICONS = {
	// Apps and navigation
	mail: Mail,
	calendar: Calendar,
	contacts: ContactRound,
	assistant: Sparkles,
	settings: Settings,
	menu: Menu,
	back: ArrowLeft,
	'collapse-sidebar': PanelLeftClose,
	'expand-sidebar': PanelLeftOpen,
	'reading-pane': PanelRight,
	previous: ChevronLeft,
	next: ChevronRight,
	/** A closed section; rotate it a quarter turn for open. */
	expand: ChevronRight,
	dropdown: ChevronDown,
	/** Arrows, not chevrons: beside an open/close chevron, a chevron reads as a second one. */
	'move-up': MoveUp,
	'move-down': MoveDown,

	// Folders and Inbox tabs
	inbox: Inbox,
	star: Star,
	'remind-later': AlarmClock,
	unsnooze: AlarmClockOff,
	drafts: FilePenLine,
	sent: Send,
	scheduled: CalendarClock,
	junk: ShieldAlert,
	trash: Trash,
	archive: Archive,
	folder: Folder,
	'tab-important': Inbox,
	'tab-updates': BellDot,
	'tab-newsletters': Newspaper,
	'tab-promotions': Tag,

	// Reading and acting on mail
	compose: SquarePen,
	reply: Reply,
	'reply-all': ReplyAll,
	forward: Forward,
	delete: Trash,
	spam: ShieldAlert,
	'not-spam': ShieldCheck,
	'move-to-folder': FolderInput,
	'move-to-tab': PanelsTopLeft,
	'mark-read': MailOpen,
	'mark-unread': MailDot,
	print: Printer,
	'add-contact': UserPlus,
	'create-event': CalendarPlus,
	code: KeyRound,
	copy: Copy,
	attachment: Paperclip,
	refresh: RefreshCw,
	filter: Funnel,
	download: Download,
	'file-image': FileImage,
	'file-pdf': FileText,
	'file-video': FileVideoCamera,
	'file-audio': FileMusic,
	'file-document': FileText,
	file: File,

	// Composer
	minimize: Minus,
	'full-screen': Maximize2,
	'exit-full-screen': Minimize2,
	restore: ChevronUp,
	bold: Bold,
	italic: Italic,
	underline: Underline,
	strikethrough: Strikethrough,
	'text-size': ALargeSmall,
	'text-color': Baseline,
	highlight: Highlighter,
	'bulleted-list': List,
	'numbered-list': ListOrdered,
	quote: TextQuote,
	'align-left': TextAlignStart,
	'align-center': TextAlignCenter,
	'align-right': TextAlignEnd,
	'direction-rtl': PilcrowLeft,
	'clear-formatting': RemoveFormatting,
	more: Ellipsis,
	link: Link,
	emoji: FaceSlightlySmiling,
	importance: ArrowUpDown,
	'importance-high': ArrowUp,
	'importance-low': ArrowDown,
	signature: Signature,
	'send-later': ChevronUp,
	'pick-date': Calendar,
	loading: LoaderCircle,

	// Calendar
	time: Clock,
	repeat: Repeat,
	reminder: Bell,
	location: MapPin,
	notes: NotepadText,
	guests: Users,
	edit: Pencil,

	// Contacts, search and the assistant
	group: Users,
	search: Search,
	'no-results': SearchX,
	help: CircleQuestionMark,
	history: RotateCcwClock,
	task: SquareCheck,
	send: Send,

	// Everywhere
	add: Plus,
	close: X,
	check: Check,
	error: CircleAlert,
	passkey: UserKey,
	photo: Camera,
	'zoom-in': ZoomIn,
	'zoom-out': ZoomOut,
	'sign-out': LogOut,
	'sign-in': LogIn,
	'coming-soon': Hourglass
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

/**
 * A mailbox's icon from its role, including the app's own pseudo-roles for
 * Remind Me Later and Scheduled; any other folder gets the plain folder.
 */
export function mailboxIconName(role: string | null | undefined): IconName {
	switch (role) {
		case 'inbox':
			return 'inbox';
		case 'remind-me-later':
			return 'remind-later';
		case 'drafts':
			return 'drafts';
		case 'scheduled':
			return 'scheduled';
		case 'sent':
			return 'sent';
		case 'archive':
			return 'archive';
		case 'junk':
			return 'junk';
		case 'trash':
			return 'trash';
		default:
			return 'folder';
	}
}
