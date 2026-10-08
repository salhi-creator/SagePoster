 
import prepareTelegramPost from './prepareTelegramPost.js'
import type { PostForm } from '../../Data-Structure/types.js';
async function handleSchedulePost({content}:{content:string}) {
    const post = await prepareTelegramPost(content, true)
}


export default handleSchedulePost;