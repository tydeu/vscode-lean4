import * as React from 'react';
import fastIsEqual from 'react-fast-compare';
import { Location, DocumentUri, Diagnostic, DiagnosticSeverity, PublishDiagnosticsParams } from 'vscode-languageserver-protocol';

import { LeanDiagnostic, RpcSessionAtPos } from '@leanprover/infoview-api';

import { basename, escapeHtml, RangeHelpers, usePausableState, useEvent, addUniqueKeys, DocumentPosition, useServerNotificationState } from './util';
import { ConfigContext, EditorContext, LspDiagnosticsContext, VersionContext } from './contexts';
import { Details } from './collapsing';
import { InteractiveMessage } from './traceExplorer';
import { getInteractiveDiagnostics, InteractiveDiagnostic, TaggedText_stripTags } from '@leanprover/infoview-api';
import { RpcContext, useRpcSessionAtPos } from './rpcSessions';

interface MessageViewProps {
    uri: DocumentUri;
    diag: InteractiveDiagnostic;
}

const MessageView = React.memo(({uri, diag}: MessageViewProps) => {
    const ec = React.useContext(EditorContext);
    const fname = escapeHtml(basename(uri));
    const {line, character} = diag.range.start;
    const loc: Location = { uri, range: diag.range };
    const text = TaggedText_stripTags(diag.message);
    const severityClass = diag.severity ? {
        [DiagnosticSeverity.Error]: 'error',
        [DiagnosticSeverity.Warning]: 'warning',
        [DiagnosticSeverity.Information]: 'information',
        [DiagnosticSeverity.Hint]: 'hint',
    }[diag.severity] : '';
    const title = `${fname}:${line+1}:${character}`;
    return (
    <details open>
        <summary className={severityClass + ' mv2 pointer'}>{title}
            <span className="fr">
                <a className="link pointer mh2 dim codicon codicon-go-to-file"
                   onClick={e => { e.preventDefault(); void ec.revealLocation(loc); }}
                   title="reveal file location"></a>
                <a className="link pointer mh2 dim codicon codicon-quote"
                   data-id="copy-to-comment"
                   onClick={e => {e.preventDefault(); void ec.copyToComment(text)}}
                   title="copy message to comment"></a>
                <a className="link pointer mh2 dim codicon codicon-clippy"
                   onClick={e => {e.preventDefault(); void ec.api.copyToClipboard(text)}}
                   title="copy message to clipboard"></a>
            </span>
        </summary>
        <div className="ml1">
            <pre className="font-code pre-wrap">
                <InteractiveMessage fmt={diag.message} />
            </pre>
        </div>
    </details>
    )
}, fastIsEqual)

function mkMessageViewProps(uri: DocumentUri, messages: InteractiveDiagnostic[]): MessageViewProps[] {
    const views: MessageViewProps[] = messages
        .sort((msga, msgb) => {
            const a = msga.fullRange?.end || msga.range.end;
            const b = msgb.fullRange?.end || msgb.range.end;
            return a.line === b.line ? a.character - b.character : a.line - b.line
        }).map(m => {
            return { uri, diag: m };
        });

    return addUniqueKeys(views, v => DocumentPosition.toString({uri: v.uri, ...v.diag.range.start}));
}

/** Shows the given messages assuming they are for the given file. */
export function MessagesList({uri, messages}: {uri: DocumentUri, messages: InteractiveDiagnostic[]}) {
    const should_hide = messages.length === 0;
    if (should_hide) { return <>No messages.</> }

    return (
    <div className="ml1">
        {mkMessageViewProps(uri, messages).map(m => <MessageView {...m} />)}
    </div>
    );
}

function lazy<T>(f: () => T): () => T {
    let state: {t: T} | undefined
    return () => {
        if (!state) state = {t: f()}
        return state.t
    }
}

/** Displays all messages for the specified file. Can be paused. */
export function AllMessages({uri: uri0}: { uri: DocumentUri }) {
    const ec = React.useContext(EditorContext);
    const sv = React.useContext(VersionContext);
    const rs0 = useRpcSessionAtPos({ uri: uri0, line: 0, character: 0 });
    const dc = React.useContext(LspDiagnosticsContext);
    const config = React.useContext(ConfigContext);
    const diags0 = dc.get(uri0) || [];

    const iDiags0 = React.useMemo(() => lazy(async () => {
        if (sv?.hasWidgetsV1()) {
            try {
                const diags = await getInteractiveDiagnostics(rs0);
                if (diags.length > 0) {
                    return diags
                }
            } catch (err: any) {
                if (err?.code === -32801) {
                    // Document has been changed since we made the request. This can happen
                    // while typing quickly. When the server catches up on next edit, it will
                    // send new diagnostics to which the infoview responds by calling
                    // `getInteractiveDiagnostics` again.
                } else {
                    console.log('getInteractiveDiagnostics error ', err)
                }
            }
        }
        return diags0.map(d => ({ ...(d as LeanDiagnostic), message: { text: d.message } }));
    }), [sv, rs0, uri0, diags0]);
    const [isPaused, setPaused, [uri, rs, diags, iDiags], _] = usePausableState(false, [uri0, rs0, diags0, iDiags0]);

    // Fetch interactive diagnostics when we're entering the paused state
    // (if they haven't already been fetched before)
    React.useEffect(() => void (isPaused && iDiags()), [iDiags, isPaused]);

    const setOpenRef = React.useRef<React.Dispatch<React.SetStateAction<boolean>>>();
    useEvent(ec.events.requestedAction, act => {
        if (act.kind === 'toggleAllMessages' && setOpenRef.current !== undefined) {
            setOpenRef.current(t => !t);
        }
    });

    return (
    <RpcContext.Provider value={rs}>
    <Details setOpenRef={setOpenRef as any} initiallyOpen={!config.infoViewAutoOpenShowGoal}>
        <summary className="mv2 pointer">
            All Messages ({diags.length})
            <span className="fr">
                <a className={'link pointer mh2 dim codicon ' + (isPaused ? 'codicon-debug-continue' : 'codicon-debug-pause')}
                   onClick={e => { e.preventDefault(); setPaused(p => !p); }}
                   title={isPaused ? 'continue updating' : 'pause updating'}>
                </a>
            </span>
        </summary>
        <AllMessagesBody uri={uri} messages={iDiags} />
    </Details>
    </RpcContext.Provider>
    )
}

/** We factor out the body of {@link AllMessages} which lazily fetches its contents only when expanded. */
function AllMessagesBody({uri, messages}: {uri: DocumentUri, messages: () => Promise<InteractiveDiagnostic[]>}) {
    const [msgs, setMsgs] = React.useState<InteractiveDiagnostic[] | undefined>(undefined)
    React.useEffect(() => void messages().then(setMsgs), [messages])
    if (msgs === undefined) return <>Loading messages...</>
    else return <MessagesList uri={uri} messages={msgs}/>
}

/**
 * Provides a `LspDiagnosticsContext` which stores the latest version of the
 * diagnostics as sent by the publishDiagnostics notification.
 */
export function WithLspDiagnosticsContext({children}: React.PropsWithChildren<{}>) {
    const [allDiags, _0] = useServerNotificationState(
        'textDocument/publishDiagnostics',
        new Map<DocumentUri, Diagnostic[]>(),
        async (params: PublishDiagnosticsParams) => diags =>
            new Map(diags).set(params.uri, params.diagnostics),
        []
    )

    return <LspDiagnosticsContext.Provider value={allDiags}>{children}</LspDiagnosticsContext.Provider>
}

export function useMessagesForFile(rs: RpcSessionAtPos, uri: DocumentUri, line?: number): InteractiveDiagnostic[] {
    const sv = React.useContext(VersionContext)
    const lspDiags = React.useContext(LspDiagnosticsContext)
    const [diags, setDiags] = React.useState<InteractiveDiagnostic[]>([])

    async function updateDiags() {
        setDiags((lspDiags.get(uri) || []).map(d => ({ ...(d as LeanDiagnostic), message: { text: d.message } })));
        if (sv?.hasWidgetsV1()) {
            try {
                const diags = await getInteractiveDiagnostics(rs,
                    line ? { start: line, end: line + 1 } : undefined)
                if (diags.length > 0) {
                    // diags may be [] when lake fails
                    setDiags(diags)
                }
            } catch (err: any) {
                if (err?.code === -32801) {
                    // Document has been changed since we made the request.
                    // This can happen while typing quickly, so server will catch up on next edit.
                } else {
                    console.log('getInteractiveDiagnostics error ', err)
                }
            }
        }
    }
    React.useEffect(() => void updateDiags(), [uri, line, rs, lspDiags.get(uri)])
    return diags;
}

export function useMessagesFor(rs: RpcSessionAtPos, pos: DocumentPosition): InteractiveDiagnostic[] {
    const config = React.useContext(ConfigContext);
    return useMessagesForFile(rs, pos.uri, pos.line).filter(d => RangeHelpers.contains(d.range, pos, config.infoViewAllErrorsOnLine));
}
