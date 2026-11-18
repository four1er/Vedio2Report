/**
 * 为用户给出的安德森访谈示例编写的演示对话，依据题面提供的主题，
 * 不代表视频中的逐字发言。来源标识随正文传给模型和页面。
 */
export const sampleVideoId = "xRh2sVcNXQ8";

export const sampleCaptions = {
  source: "sample",
  title: "AI 经济的收入与成本（内置示例素材）",
  text: `【原创演示对话，依据示例题面编写，不是视频逐字稿。人物为示例主持人与分析者，不得将发言归于真实受访者。】
主持人：一家企业决定购买 AI 服务时，究竟在买什么？
分析者：它在购买可以核算的工作成果。以客服为例，可以比较引入前后每个工单花费的时间，还要把人工复核与错误返工算进去。指标定义清楚，采购团队才能判断订阅是否值得续费。

主持人：个人订阅和企业采购会用同一种定价办法吗？
分析者：个人希望开支可预测，因此每月固定的订阅费容易理解。企业的调用量会波动，按 token 计费能反映实际用量，却不一定反映业务价值。服务商也可以按完成的任务收费，前提是双方能约定怎样算完成。

主持人：为什么这一轮产品能够这么快触达用户？
分析者：已有的互联网服务、应用商店和支付体系缩短了分发路径。用户打开熟悉的工具，就能试到新功能。不过第一次尝试很容易，长期使用仍取决于答案是否可靠，以及它是否真的节省了时间。

主持人：当 GPU 和数据中心的供给改善，一次调用变便宜，会发生什么？
分析者：过去太贵的任务可能变得可行，比如为更多工单生成候选回复。但单位成本下降并不保证总支出下降。企业可能增加调用频次，还会尝试更复杂的任务。要同时观察单位成本、总用量和最终产出。

主持人：如果只能给正在试点的团队一个建议，你会选择什么？
分析者：先挑一个可以人工核验、已有历史基线的小任务，记录节省的工时与新增的复核成本。用这些数据决定要不要扩大试点，别把一次漂亮的演示当成全面部署的依据。`,
};

/**
 * W3C Web Accessibility Initiative (WAI), Education and Outreach Working Group; Evaluating Web Accessibility: Resources Overview; CC BY 4.0. Audio transcript only, visual descriptions and timing omitted.
 * Source: https://www.w3.org/WAI/test-evaluate/#transcript
 * License: https://creativecommons.org/licenses/by/4.0/
 */
export const cachedVideoId = "C4GIqWeywiI";

export const cachedCaptions = {
  source: "cached",
  title: "Evaluating Web Accessibility: Resources Overview",
  text: `Evaluating web accessibility: resources overview
Evaluation helps you ensure that your websites and applications meet accessibility requirements.
Ideally you evaluate regularly throughout the design and development process. This way you find errors early and avoid costly repairs later in the process.
The W3C Web Accessibility Initiative, W-A-I, or WAI, provides free resources to help you with your evaluation.
"Easy Checks - A First Review of Web Accessibility" explains how you can do some checks yourself.
Even if you are new to web accessibility and not technical, these checks give you a rough idea of the accessibility of any web page.
WAI also maintains a "Web Accessibility Evaluation Tools List" that you can filter.
"Selecting Web Accessibility Evaluation Tools" explains what tools can and cannot do.
For more experienced evaluators, WAI provides "WCAG-EM", the "Website Accessibility Conformance Evaluation Methodology".
The "WCAG-EM Report Tool" helps you record the findings as you follow the methodology.
To help you better understand how different users experience your website and applications, WAI provides guidance in "Involving Users in Web Projects for Better, Easier Accessibility" and "Involving users in Evaluating Web Accessibility."
With all these resources, you can learn how to check your website for accessibility and prioritize the issues you need to address first.
Web accessibility: essential for some, useful for all.
For resources on evaluating web accessibility, visit w3.o-r-g/W-A-I/evaluation.`,
};
