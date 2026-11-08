import type { CloudFeedback, CloudFeedbackReply, FeedbackCategory, FeedbackStatus, RecycledFeedback } from './cloudFeedback';
import type { Announcement, AnnouncementDraft, FeedbackReplyStatus } from './messageState';

type FunctionResult = { result?: { ok?: boolean; data?: unknown; error?: string } };
type CloudFunctionClient = { callFunction: (input: { name: string; data: Record<string, unknown>; parse: true }) => Promise<FunctionResult> };

// The supplied client owns its CloudBase session; no credentials or user IDs are
// accepted as action parameters. The server authenticates every request.
export function createClassicFeedback(client: CloudFunctionClient) {
  async function call<T>(action: string, args: Record<string, unknown> = {}): Promise<T> {
    const response = await client.callFunction({ name:'lijin_feedback_v1', data:{...args,action}, parse:true });
    if (!response.result || response.result.ok !== true) throw new Error(response.result?.error || '云端反馈服务暂不可用');
    return response.result.data as T;
  }
  return {
    adminStatus: () => call<{is_admin:boolean}>('adminStatus'),
    list: () => call<CloudFeedback[]>('list'),
    replies: (id:string) => call<CloudFeedbackReply[]>('replies',{id}),
    submit: (input:{category:FeedbackCategory;content:string;appVersion:string}) => call<CloudFeedback>('submit',input),
    reply: (id:string,content:string,status:FeedbackStatus) => call<{success:boolean}>('reply',{id,content,status}),
    status: (id:string,status:FeedbackStatus) => call<{success:boolean}>('status',{id,status}),
    recycle: (id:string) => call<{success:boolean}>('recycle',{id}),
    restore: (id:string) => call<{success:boolean}>('restore',{id}),
    recycled: () => call<RecycledFeedback[]>('recycled'),
    announcements: () => call<Announcement[]>('announcements'),
    drafts: () => call<AnnouncementDraft[]>('drafts'),
    saveDraft: (input:{id?:string;title:string;body:string}) => call<AnnouncementDraft>('saveDraft',input),
    publish: (id:string) => call<Announcement>('publish',{id}),
    replyStatus: async (): Promise<FeedbackReplyStatus[]> => (await call<CloudFeedback[]>('list')).map(({id,last_replied_at,status,status_changed_at}) => ({id,last_replied_at,status,status_changed_at})),
  };
}
