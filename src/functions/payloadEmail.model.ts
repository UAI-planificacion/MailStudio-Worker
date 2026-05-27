export enum Priority {
    NORMAL = "NORMAL",
    HIGH   = "HIGH"
}


export interface PayloadEmail {
    student         : PayloadStudent;
    templateId?     : string;
    templateFileId? : string;
    subject         : string;
    notificationId  : string;
    priority?       : Priority | null;
    cc?             : string[] | null;
    bcc?            : string[] | null;
}


export interface PayloadStudent {
    email       : string;
    name?       : string | null;
    customData? : Record<string, string> | null;
}


export interface PayloadRecurrent {
    workflowId     : string;
    cronRule       : string | null;
    sendEmailLogId : string;
}


export interface Template {
    id      : string;
    content : string;
}


export type RecurrenceFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY' | 'ONCE';


export interface Workflow {
    id              : string;
    name            : string;
    active          : boolean;
    students        : PayloadStudent[];
    subject         : string | null;
    cc              : string[];
    bcc             : string[];
    template?       : Template;
    templateFileId? : string;
    frequency       : RecurrenceFrequency;
    hour            : number;
    minute          : number;
    daysOfWeek      : number[];
    dayOfMonth      : number | null;
    lastDayOfMonth  : boolean | null;
    occurrences     : number | null;
    repeatUntil     : string | null;
    neverEnds       : boolean | null;
}


export interface PrepareExecutionResponse {
    shouldStop     : boolean;
    reason?        : string;
    sendEmailLogId?: string;
}

